import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import { extname, join, normalize, sep } from 'path';
import { Readable } from 'stream';
import {
  RequestMethod,
  VERSION_NEUTRAL,
  VersioningOptions,
  VersioningType,
} from '@nestjs/common';
import { VersionValue } from '@nestjs/common/interfaces';
import { NestApplicationOptions } from '@nestjs/common/interfaces/nest-application-options.interface';
import { AbstractHttpAdapter } from '@nestjs/core';

export interface BunRequest {
  method: string;
  url: string;
  originalUrl: string;
  baseUrl: string;
  path: string;
  hostname: string;
  ip: string;
  headers: Record<string, string>;
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  body: any;
  rawBody?: Buffer;
  /** Reference to the underlying Web `Request` object. */
  bunRequest: Request;
  get(name: string): string | undefined;
  header(name: string): string | undefined;
}

/**
 * Plain-object outbound headers map. Bun.serve accepts `Record<string,string>`
 * for the `Response` headers init, so we skip the cost of constructing a real
 * `Headers` instance per request. Multi-value headers are stored as arrays.
 */
export type BunResponseHeaders = Record<string, string | string[]>;

export interface BunResponse {
  statusCode: number;
  headers: BunResponseHeaders;
  body: any;
  headersSent: boolean;
  finished: boolean;
  _resolve: (response: Response) => void;
  _reject: (err: any) => void;
  req: BunRequest;
  status(code: number): BunResponse;
  send(body?: any): BunResponse;
  json(body: any): BunResponse;
  end(message?: string): BunResponse;
  redirect(urlOrStatus: number | string, maybeUrl?: string): BunResponse;
  set(name: string, value?: string): BunResponse;
  header(name: string, value?: string): BunResponse;
  get(name: string): string | undefined;
  type(contentType: string): BunResponse;
}

function toResponseInit(headers: BunResponseHeaders, status: number) {
  // Bun.serve handles plain objects + arrays natively; no Headers needed.
  return { status, headers: headers as any };
}

// Pre-allocated frozen empty maps — reused across requests that don't have
// query or path params, to skip per-request object allocations.
const EMPTY_QUERY: Record<string, string | string[]> = Object.freeze(Object.create(null));
const EMPTY_PARAMS: Record<string, string> = Object.freeze(Object.create(null));

type BunRouteHandler = (
  req: BunRequest,
  res: BunResponse,
  next?: (err?: any) => void,
) => any;

interface CompiledRoute {
  method: string;
  rawPath: string;
  regexp: RegExp;
  keys: { name: string }[];
  handler: BunRouteHandler;
  isMiddleware: boolean;
}

class BunRouterInstance {
  public readonly routes: CompiledRoute[] = [];
  public readonly middleware: Array<{
    prefix: string;
    handler: BunRouteHandler;
  }> = [];
  /**
   * `path → method → handler[]`. Mirrors `routes` but indexed for native
   * Bun.serve `routes:` config — built once on listen().
   */
  public readonly byPath: Map<string, Map<string, BunRouteHandler[]>> = new Map();

  add(method: string, path: string, handler: BunRouteHandler) {
    const upper = method.toUpperCase();
    const { regexp, keys } = compilePath(path);
    this.routes.push({
      method: upper,
      rawPath: path,
      regexp,
      keys,
      handler,
      isMiddleware: upper === 'USE',
    });
    if (upper === 'USE') return;
    let bucket = this.byPath.get(path);
    if (!bucket) {
      bucket = new Map();
      this.byPath.set(path, bucket);
    }
    let arr = bucket.get(upper);
    if (!arr) {
      arr = [];
      bucket.set(upper, arr);
    }
    arr.push(handler);
  }

  use(prefix: string, handler: BunRouteHandler) {
    this.middleware.push({ prefix, handler });
  }

  matchAll(method: string, pathname: string) {
    const upper = method;
    const matches: { route: CompiledRoute; params: Record<string, string> }[] = [];
    for (const route of this.routes) {
      if (route.method !== upper && route.method !== 'ALL' && route.method !== 'USE')
        continue;
      const m = route.regexp.exec(pathname);
      if (!m) continue;
      let params: Record<string, string>;
      if (route.keys.length === 0) {
        params = EMPTY_PARAMS;
      } else {
        params = Object.create(null);
        for (let i = 0; i < route.keys.length; i++) {
          const v = m[i + 1];
          if (v !== undefined) params[route.keys[i].name] = decodeURIComponent(v);
        }
      }
      matches.push({ route, params });
    }
    return matches;
  }
}

function compilePath(path: string): {
  regexp: RegExp;
  keys: { name: string }[];
} {
  if (
    path === '*' ||
    path === '/*' ||
    path === '/(.*)' ||
    path === '(.*)' ||
    path === '/(.*)?'
  ) {
    return { regexp: /^\/.*$/, keys: [] };
  }
  if (path === '/' || path === '') {
    return { regexp: /^\/?$/, keys: [] };
  }
  const keys: { name: string }[] = [];
  const cleaned = path.startsWith('/') ? path : '/' + path;
  const segments = cleaned.split('/').filter(Boolean);
  const out = segments
    .map(seg => {
      if (seg.startsWith(':')) {
        const name = seg.slice(1).replace(/[?(].*$/, '');
        keys.push({ name });
        return '([^/]+)';
      }
      if (seg === '*' || seg === '(.*)') {
        return '.*';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  const regexp = new RegExp('^/' + out + '/?$');
  return { regexp, keys };
}

class BunHttpServer extends EventEmitter {
  public listening = false;
  private bunServer: any = null;
  private boundPort = 0;
  private boundHost = '127.0.0.1';
  /** Optional native Bun routes config built by the adapter at listen-time. */
  public routes: any = undefined;

  constructor(
    private readonly fetchHandler: (
      req: Request,
      server?: any,
    ) => Promise<Response> | Response,
  ) {
    super();
  }

  listen(
    port: number | string,
    hostnameOrCb?: string | ((err?: Error) => void),
    maybeCb?: (err?: Error) => void,
  ) {
    const hostname = typeof hostnameOrCb === 'string' ? hostnameOrCb : '0.0.0.0';
    const cb = typeof hostnameOrCb === 'function' ? hostnameOrCb : maybeCb;
    try {
      const portNumber = Number(port);
      const ServeFn = (globalThis as any).Bun?.serve;
      if (!ServeFn) {
        const err = new Error(
          'Bun runtime not detected. platform-bun requires the Bun runtime.',
        );
        this.emit('error', err);
        if (cb) (cb as any).call(this, err);
        return this;
      }
      const config: any = {
        port: portNumber,
        hostname,
        fetch: this.fetchHandler,
        websocket: {
          open: (ws: any) => {
            const client = ws.data?.client;
            const server = ws.data?.server;
            if (client && server) {
              client.bunWs = ws;
              server.clients.add(client);
              client.__markOpen();
              server.emit('connection', client, undefined);
            }
          },
          message: (ws: any, message: string | Buffer) => {
            const client = ws.data?.client;
            client?.__onMessage(message);
          },
          close: (ws: any, code: number, reason: string) => {
            const client = ws.data?.client;
            const server = ws.data?.server;
            if (client) {
              server?.clients.delete(client);
              client.__onClose(code, reason);
            }
          },
          drain: () => {},
        },
        error: (err: Error) => {
          this.emit('error', err);
          return new Response('Internal Server Error', { status: 500 });
        },
      };
      if (this.routes) config.routes = this.routes;
      this.bunServer = ServeFn(config);
      this.boundPort = this.bunServer.port;
      this.boundHost = this.bunServer.hostname || hostname;
      this.listening = true;
      if (cb) (cb as any).call(this);
      this.emit('listening');
    } catch (err) {
      this.emit('error', err);
      if (cb) (cb as any).call(this, err);
    }
    return this;
  }

  address() {
    if (!this.listening) return null;
    return {
      port: this.boundPort,
      address: this.boundHost,
      family: this.boundHost.includes(':') ? 'IPv6' : 'IPv4',
    };
  }

  close(cb?: (err?: Error) => void) {
    try {
      this.bunServer?.stop();
      this.listening = false;
      this.emit('close');
      if (cb) cb();
    } catch (err) {
      if (cb) cb(err as Error);
    }
    return this;
  }
}

interface StaticEntry {
  prefix: string;
  root: string;
  index: string;
}

/**
 * @publicApi
 */
export class BunHttpAdapter extends AbstractHttpAdapter<
  BunHttpServer,
  BunRequest,
  BunResponse
> {
  private bodyParserEnabled = false;
  /** Set to true when Nest is configured with `rawBody: true` — only then
   *  do we materialise `req.rawBody`. Without it we take the JSON fast path
   *  that hands bytes straight to Bun's native parser. */
  private rawBodyEnabled = false;
  private corsOptions: any = null;
  private notFoundHandler: BunRouteHandler | null = null;
  private errorHandler:
    | ((err: any, req: BunRequest, res: BunResponse, next: Function) => void)
    | null = null;
  private readonly router = new BunRouterInstance();
  private readonly staticAssets: StaticEntry[] = [];
  public readonly wsPaths = new Map<string, any>();

  constructor() {
    super(undefined);
    this.setInstance(this.router);
  }

  public override async init() {}

  public initHttpServer(_options: NestApplicationOptions): void {
    const server = new BunHttpServer((req, bunServer) => this.handle(req, bunServer));
    (server as any).adapter = this;
    this.setHttpServer(server);
  }

  public override listen(port: string | number, hostnameOrCb?: any, cb?: any): any {
    // Build native Bun.serve `routes` ONLY when there is no fast-path-blocking
    // feature in use. Middleware / static / CORS / version filters all fall
    // back to the manual `fetch` dispatcher because Bun.routes can't model
    // multi-match `next()`-chaining or path-prefix middleware.
    // notFoundHandler is OK to coexist with native routes — when no route
    // matches, Bun.serve falls through to the `fetch` callback, which still
    // runs our `handle()` and ends in dispatchNotFound().
    if (
      this.router.middleware.length === 0 &&
      this.staticAssets.length === 0 &&
      this.corsOptions === null
    ) {
      this.httpServer.routes = this.buildBunRoutes();
    }
    const server = this.httpServer.listen(port, hostnameOrCb, cb);
    const nativeServer = (this.httpServer as any).bunServer;
    if (nativeServer) {
      for (const wsServer of this.wsPaths.values()) {
        wsServer.bunServer = nativeServer;
      }
    }
    return server;
  }

  /** Build the `Bun.serve({ routes })` map from the adapter's collected paths. */
  private buildBunRoutes(): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [path, methodMap] of this.router.byPath) {
      const bunPath = toBunRoutePath(path);
      const methodHandler: Record<string, any> = {};
      for (const [method, handlers] of methodMap) {
        // Keep a closure that reuses the prepared handler list. For a single
        // handler we run it directly; for many (versioning, ALL+specific)
        // we walk the chain with `next()` semantics. Either way, returning
        // `undefined` from the route handler triggers Bun to fall through
        // to the `fetch` callback (which then renders our 404 JSON).
        if (handlers.length === 1 && method !== 'ALL') {
          const h = handlers[0];
          methodHandler[method] = (req: any) => this.runBunRouteSingle(req, h);
        } else {
          methodHandler[method] = (req: any) => this.runBunRouteChain(req, handlers);
        }
      }
      // ALL handlers are invoked for any method that has no explicit entry.
      const allHandlers = methodMap.get('ALL');
      if (allHandlers && allHandlers.length) {
        // Collapse ALL into the wildcard form Bun expects (default route).
        out[bunPath] = (req: any) => {
          // Try method-specific first when present (Bun won't dispatch them
          // because we register the same path twice — instead we attach all
          // logic here).
          const methodSpecific = methodMap.get(req.method);
          const queue = methodSpecific
            ? [...methodSpecific, ...allHandlers]
            : allHandlers;
          return this.runBunRouteChain(req, queue);
        };
      } else {
        out[bunPath] = methodHandler;
      }
    }
    return out;
  }

  public close() {
    return new Promise<void>(resolve => {
      if (!this.httpServer) return resolve();
      this.httpServer.close(() => resolve());
    });
  }

  public getType(): string {
    return 'bun';
  }

  // ---------- routing methods ----------
  public override get(...args: any[]) {
    return this.registerRoute('GET', args);
  }
  public override post(...args: any[]) {
    return this.registerRoute('POST', args);
  }
  public override put(...args: any[]) {
    return this.registerRoute('PUT', args);
  }
  public override delete(...args: any[]) {
    return this.registerRoute('DELETE', args);
  }
  public override patch(...args: any[]) {
    return this.registerRoute('PATCH', args);
  }
  public override head(...args: any[]) {
    return this.registerRoute('HEAD', args);
  }
  public override options(...args: any[]) {
    return this.registerRoute('OPTIONS', args);
  }
  public override all(...args: any[]) {
    return this.registerRoute('ALL', args);
  }
  public override search(...args: any[]) {
    return this.registerRoute('SEARCH', args);
  }
  public override use(...args: any[]) {
    let prefix = '/';
    let handler: BunRouteHandler;
    if (typeof args[0] === 'string') {
      prefix = args[0];
      handler = args[1];
    } else {
      handler = args[0];
    }
    if (typeof handler !== 'function') return;
    this.router.use(prefix, handler);
    if (this.httpServer?.listening) {
      this.reloadRoutes();
    }
  }

  private registerRoute(method: string, args: any[]) {
    let path = '/';
    let handler: BunRouteHandler;
    if (typeof args[0] === 'string' || args[0] instanceof RegExp) {
      path = String(args[0]);
      handler = args[1];
    } else {
      handler = args[0];
    }
    if (typeof handler !== 'function') return;
    this.router.add(method, path, handler);
    if (this.httpServer?.listening) {
      this.reloadRoutes();
    }
  }

  private reloadRoutes() {
    if (!this.httpServer || !(this.httpServer as any).bunServer) return;
    if (
      this.router.middleware.length === 0 &&
      this.staticAssets.length === 0 &&
      this.corsOptions === null
    ) {
      const routes = this.buildBunRoutes();
      this.httpServer.routes = routes;
      (this.httpServer as any).bunServer.reload({ routes });
    } else {
      this.httpServer.routes = undefined;
      (this.httpServer as any).bunServer.reload({ routes: {} });
    }
  }

  // ---------- request/response helpers ----------
  public getRequestUrl(request: BunRequest) {
    return request.url;
  }
  public getRequestMethod(request: BunRequest) {
    return request.method;
  }
  public getRequestHostname(request: BunRequest) {
    return request.hostname;
  }

  public status(response: BunResponse, statusCode: number) {
    response.statusCode = statusCode;
    return response;
  }

  public reply(response: BunResponse, body: any, statusCode?: number) {
    if (response.finished) return;
    if (statusCode !== undefined) response.statusCode = statusCode;

    // StreamableFile — Nest's wrapper around a Node Readable stream. Convert
    // to a web ReadableStream and stream it back through Bun.serve.
    if (body && typeof body === 'object' && isStreamableFile(body)) {
      this.replyStreamable(response, body);
      return;
    }
    // Bare Node Readable — also convert to web stream.
    if (body && typeof body.pipe === 'function' && typeof body.read === 'function') {
      this.replyNodeReadable(response, body);
      return;
    }

    if (body === undefined || body === null) {
      response.body = null;
      response.finished = true;
      response.headersSent = true;
      response._resolve(
        new Response(null, toResponseInit(response.headers, response.statusCode)),
      );
      return;
    }
    if (typeof body === 'string') {
      if (response.headers['content-type'] === undefined) {
        response.headers['content-type'] = 'text/html; charset=utf-8';
      }
      response.body = body;
      response.finished = true;
      response.headersSent = true;
      response._resolve(
        new Response(body, toResponseInit(response.headers, response.statusCode)),
      );
      return;
    }
    if (
      body instanceof Uint8Array ||
      body instanceof ArrayBuffer ||
      body instanceof Blob ||
      body instanceof ReadableStream
    ) {
      response.body = body;
      response.finished = true;
      response.headersSent = true;
      response._resolve(
        new Response(body as any, toResponseInit(response.headers, response.statusCode)),
      );
      return;
    }
    // JSON fast path: Bun's `Response.json(value, init)` serialises to bytes
    // natively, skipping the JS-string allocation `JSON.stringify` would
    // produce. Headers in `init` win over the default `application/json`
    // Response.json injects, so explicit `res.type('application/json; charset=utf-8')`
    // is preserved.
    if (response.headers['content-type'] === undefined) {
      response.headers['content-type'] = 'application/json; charset=utf-8';
    }
    response.body = body;
    response.finished = true;
    response.headersSent = true;
    response._resolve(
      Response.json(body, toResponseInit(response.headers, response.statusCode)),
    );
  }

  private replyStreamable(response: BunResponse, file: any) {
    const headers = response.headers;
    const meta = file.getHeaders();
    if (meta?.type && headers['content-type'] === undefined) {
      headers['content-type'] = meta.type;
    }
    if (meta?.disposition && headers['content-disposition'] === undefined) {
      headers['content-disposition'] = meta.disposition;
    }
    if (meta?.length !== undefined && headers['content-length'] === undefined) {
      headers['content-length'] = String(meta.length);
    }
    const nodeStream = file.getStream();
    this.streamNodeReadable(response, nodeStream);
  }

  private replyNodeReadable(response: BunResponse, nodeStream: any) {
    if (response.headers['content-type'] === undefined) {
      response.headers['content-type'] = 'application/octet-stream';
    }
    this.streamNodeReadable(response, nodeStream);
  }

  private streamNodeReadable(response: BunResponse, nodeStream: any) {
    let webStream: ReadableStream;
    // Use Node's `Readable.toWeb` (statically imported from `node:stream`) — it
    // handles backpressure and pauses the source until pull, so no data is lost.
    // The old `globalThis.require('stream')` lookup was unreliable in Bun's ESM
    // context (undefined on Linux), which silently dropped us into the racy
    // manual wrapper below and produced empty/500 streamed responses there.
    if (typeof (Readable as any)?.toWeb === 'function') {
      try {
        webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;
      } catch {
        webStream = nodeReadableToWeb(nodeStream);
      }
    } else {
      webStream = nodeReadableToWeb(nodeStream);
    }
    response.body = webStream;
    response.finished = true;
    response.headersSent = true;
    response._resolve(
      new Response(webStream, toResponseInit(response.headers, response.statusCode)),
    );
  }

  public end(response: BunResponse, message?: string) {
    if (response.finished) return;
    response.finished = true;
    response.headersSent = true;
    response._resolve(
      new Response(
        message ?? null,
        toResponseInit(response.headers, response.statusCode),
      ),
    );
  }

  public render(_response: BunResponse, _view: string, _options: any) {
    throw new Error('platform-bun: render() is not implemented');
  }

  public redirect(response: BunResponse, statusCode: number, url: string) {
    if (response.finished) return;
    response.finished = true;
    response.headersSent = true;
    response.statusCode = statusCode || 302;
    response.headers['location'] = url;
    response._resolve(
      new Response(null, toResponseInit(response.headers, response.statusCode)),
    );
  }

  public setHeader(response: BunResponse, name: string, value: string) {
    response.headers[name.toLowerCase()] = String(value);
  }
  public getHeader(response: BunResponse, name: string) {
    const v = response.headers[name.toLowerCase()];
    return Array.isArray(v) ? v.join(', ') : v;
  }
  public appendHeader(response: BunResponse, name: string, value: string) {
    const key = name.toLowerCase();
    const existing = response.headers[key];
    if (existing === undefined) {
      response.headers[key] = String(value);
    } else if (Array.isArray(existing)) {
      existing.push(String(value));
    } else {
      response.headers[key] = [existing, String(value)];
    }
  }
  public isHeadersSent(response: BunResponse) {
    return response.headersSent;
  }

  public setErrorHandler(handler: Function, _prefix?: string) {
    this.errorHandler = handler as any;
  }
  public setNotFoundHandler(handler: Function, _prefix?: string) {
    this.notFoundHandler = handler as any;
  }

  public useStaticAssets(rootOrOptions: any, maybeOptions?: any) {
    let root: string;
    let options: any = {};
    if (typeof rootOrOptions === 'string') {
      root = rootOrOptions;
      options = maybeOptions ?? {};
    } else {
      root = rootOrOptions?.root;
      options = rootOrOptions ?? {};
    }
    if (!root) return;
    this.staticAssets.push({
      prefix: options.prefix ?? '/',
      root,
      index: options.index ?? 'index.html',
    });
  }

  public setViewEngine(_engine: string) {
    throw new Error('platform-bun: setViewEngine() is not implemented');
  }

  public registerParserMiddleware(_prefix?: string, rawBody?: boolean) {
    this.bodyParserEnabled = true;
    if (rawBody) this.rawBodyEnabled = true;
  }

  public enableCors(options?: any, _prefix?: string) {
    this.corsOptions = options ?? {};
  }

  public createMiddlewareFactory(_requestMethod: RequestMethod) {
    return (path: string, callback: Function) => {
      // Nest passes patterns like '/middleware', '/middleware/(.*)' or just
      // '*'. Strip suffixes that don't carry information for our prefix
      // matcher in `runGlobalMiddleware`.
      let prefix = path || '/';
      if (prefix.endsWith('(.*)')) prefix = prefix.slice(0, -4) || '/';
      if (prefix.endsWith('/*')) prefix = prefix.slice(0, -2) || '/';
      if (prefix === '*') prefix = '/';
      if (prefix.length > 1 && prefix.endsWith('/')) prefix = prefix.slice(0, -1);
      this.router.use(prefix, callback as any);
    };
  }

  public applyVersionFilter(
    handler: Function,
    version: VersionValue,
    versioningOptions: VersioningOptions,
  ): any {
    const callNextHandler = (_req: BunRequest, _res: BunResponse, next?: Function) => {
      if (!next) {
        throw new Error('HTTP adapter does not support filtering on version');
      }
      return next();
    };

    if (version === VERSION_NEUTRAL || versioningOptions.type === VersioningType.URI) {
      return (req: BunRequest, res: BunResponse, next: Function) =>
        (handler as any)(req, res, next);
    }

    if (versioningOptions.type === VersioningType.CUSTOM) {
      return (req: BunRequest, res: BunResponse, next: Function) => {
        const extracted = (versioningOptions as any).extractor(req);
        if (Array.isArray(version)) {
          if (
            Array.isArray(extracted) &&
            version.filter(v => extracted.includes(v as string)).length
          ) {
            return (handler as any)(req, res, next);
          }
          if (typeof extracted === 'string' && version.includes(extracted)) {
            return (handler as any)(req, res, next);
          }
        } else if (typeof version === 'string') {
          if (Array.isArray(extracted) && extracted.includes(version)) {
            return (handler as any)(req, res, next);
          }
          if (typeof extracted === 'string' && version === extracted) {
            return (handler as any)(req, res, next);
          }
        }
        return callNextHandler(req, res, next);
      };
    }

    if (versioningOptions.type === VersioningType.MEDIA_TYPE) {
      return (req: BunRequest, res: BunResponse, next: Function) => {
        const accept = req.headers['accept'] ?? req.headers['Accept' as any];
        const versionParam = accept ? accept.split(';')[1] : undefined;
        if (versionParam === undefined) {
          if (Array.isArray(version) && version.includes(VERSION_NEUTRAL as any)) {
            return (handler as any)(req, res, next);
          }
        } else {
          const headerVersion = versionParam.split((versioningOptions as any).key)[1];
          if (Array.isArray(version)) {
            if (version.includes(headerVersion)) {
              return (handler as any)(req, res, next);
            }
          } else if (typeof version === 'string') {
            if (version === headerVersion) {
              return (handler as any)(req, res, next);
            }
          }
        }
        return callNextHandler(req, res, next);
      };
    }

    if (versioningOptions.type === VersioningType.HEADER) {
      const headerName = (versioningOptions as any).header.toLowerCase();
      return (req: BunRequest, res: BunResponse, next: Function) => {
        const headerVersion = req.headers[headerName];
        if (headerVersion === undefined || headerVersion === '') {
          if (Array.isArray(version) && version.includes(VERSION_NEUTRAL as any)) {
            return (handler as any)(req, res, next);
          }
        } else {
          if (Array.isArray(version)) {
            if (version.includes(headerVersion)) {
              return (handler as any)(req, res, next);
            }
          } else if (typeof version === 'string') {
            if (version === headerVersion) {
              return (handler as any)(req, res, next);
            }
          }
        }
        return callNextHandler(req, res, next);
      };
    }

    throw new Error('Unsupported versioning options');
  }

  /**
   * Parse request body when relevant. Skipped for GET/HEAD or empty payloads
   * (content-length: 0). Mutates `req.body` / `req.rawBody` in place — Nest's
   * route-params factory reads them synchronously after this returns.
   */
  private async maybeParseBody(req: BunRequest, raw: any) {
    if (!this.bodyParserEnabled) return;
    const m = req.method;
    if (m === 'GET' || m === 'HEAD') return;
    if (!raw.body) return;
    const cl = req.headers['content-length'];
    if (cl === '0') return;
    const ctype = req.headers['content-type'] ?? '';
    // Skip multipart — leave the body untouched so interceptors (e.g.
    // BunFileInterceptor) can call `req.bunRequest.formData()` themselves.
    if (ctype.startsWith('multipart/')) return;
    // JSON fast path: hand the bytes straight to Bun's native JSON parser
    // (no Buffer materialisation, no JS string allocation). Skipped when
    // the app opts into `rawBody` — we'd need the raw bytes either way.
    if (!this.rawBodyEnabled && ctype.includes('application/json')) {
      try {
        (req as any).body = await raw.json();
      } catch {
        // leave req.body undefined
      }
      return;
    }
    const buf = Buffer.from(await raw.arrayBuffer());
    if (buf.length === 0) return;
    (req as any).rawBody = buf;
    if (ctype.includes('application/json')) {
      try {
        (req as any).body = JSON.parse(buf.toString('utf8'));
      } catch {
        // leave req.body undefined
      }
    } else if (ctype.includes('application/x-www-form-urlencoded')) {
      (req as any).body = Object.fromEntries(new URLSearchParams(buf.toString('utf8')));
    } else if (ctype.startsWith('text/')) {
      (req as any).body = buf.toString('utf8');
    } else {
      (req as any).body = buf;
    }
  }

  // ---------- Bun-native routes hot path ----------
  /**
   * Single-handler Bun route — minimal allocation. Returns the Response that
   * the handler writes via `adapter.reply/end/redirect`.
   */
  private runBunRouteSingle(
    bunReq: any,
    handler: BunRouteHandler,
  ): Promise<Response> | Response {
    if (bunReq.headers?.get?.('upgrade')?.toLowerCase() === 'websocket') {
      return undefined as any;
    }
    const req = this.bunReqToShim(bunReq);
    const m = req.method;
    // Hot path: GET/HEAD without body parser — skip the async wrapper entirely.
    if (m === 'GET' || m === 'HEAD' || !this.bodyParserEnabled) {
      return this.invokeSingle(req, handler);
    }
    return this.maybeParseBody(req, bunReq).then(() => this.invokeSingle(req, handler));
  }

  private invokeSingle(req: BunRequest, handler: BunRouteHandler): Promise<Response> {
    return new Promise<Response>(resolve => {
      const res = makeBunResponse(this, req, resolve);
      try {
        const ret = handler(req, res, () => {
          if (!res.finished) this.dispatchNotFound(req, res, resolve);
        });
        if (ret && typeof (ret as any).then === 'function') {
          (ret as Promise<any>).catch(err => res._reject(err));
        }
      } catch (e) {
        res._reject(e);
      }
    });
  }

  /**
   * Multi-handler Bun route — for versioning / ALL fallthrough. Calls handlers
   * in order; if a handler invokes `next()`, the next candidate runs; if all
   * exhaust without writing a response we return 404.
   */
  private async runBunRouteChain(
    bunReq: any,
    handlers: BunRouteHandler[],
  ): Promise<Response> {
    if (bunReq.headers?.get?.('upgrade')?.toLowerCase() === 'websocket') {
      return undefined as any;
    }
    const req = this.bunReqToShim(bunReq);
    await this.maybeParseBody(req, bunReq);
    return new Promise<Response>(resolve => {
      const res = makeBunResponse(this, req, resolve);
      let idx = 0;
      const step = (err?: any) => {
        if (err) return res._reject(err);
        if (res.finished) return;
        if (idx >= handlers.length) {
          return this.dispatchNotFound(req, res, resolve);
        }
        const h = handlers[idx++];
        try {
          const ret = h(req, res, step);
          if (ret && typeof (ret as any).then === 'function') {
            (ret as Promise<any>).catch(step);
          }
        } catch (e) {
          step(e);
        }
      };
      step();
    });
  }

  /**
   * Convert a Bun.serve route `BunRequest` (already has `.params` and is the
   * native `Request`) into the shim our handlers expect. Body parsing stays
   * lazy: `req.body` only resolves when actually read.
   */
  private bunReqToShim(bunReq: any): BunRequest {
    const params = (bunReq.params ?? EMPTY_PARAMS) as Record<string, string>;
    const headers = buildHeaders(bunReq.headers);
    const method = bunReq.method;
    const url = bunReq.url as string;
    const queryStart = url.indexOf('?', 8);
    const pathStart = url.indexOf('/', 8);
    const pathname =
      pathStart === -1
        ? '/'
        : queryStart === -1
          ? url.slice(pathStart)
          : url.slice(pathStart, queryStart);
    const query = queryStart === -1 ? EMPTY_QUERY : parseQuery(url.slice(queryStart + 1));
    const fullPath = url.slice(pathStart === -1 ? 0 : pathStart);
    const hostHeader = headers['host'];
    const hostname = hostHeader ? hostHeader.split(':', 1)[0] : '';

    let bodyResolved: any = undefined;
    let bodyConsumed = false;

    const ensureBody = () => {
      if (bodyConsumed) return bodyResolved;
      if (
        !this.bodyParserEnabled ||
        method === 'GET' ||
        method === 'HEAD' ||
        !bunReq.body
      ) {
        bodyConsumed = true;
        return undefined;
      }
      // sync access path can't await — best-effort: only parse pre-emptively
      // when @Body() handler awaits via its async pipeline. We expose the
      // promise through `.bodyAsync`; the canonical `req.body` is filled in
      // before handler invocation in `runBunRouteSingle/Chain` if the route
      // is POST/PUT/PATCH and content-length > 0.
      return bodyResolved;
    };

    const reqEmitter = new EventEmitter();
    // Bridge Bun's AbortSignal → Node-style 'close' event so that
    // RouterResponseController.sse() can subscribe via `req.on('close', …)`.
    if (bunReq.signal && !bunReq.signal.aborted) {
      bunReq.signal.addEventListener('abort', () => reqEmitter.emit('close'), {
        once: true,
      });
    }

    const req: any = {
      method,
      url: fullPath,
      originalUrl: fullPath,
      baseUrl: '',
      path: pathname,
      hostname,
      ip: '127.0.0.1',
      headers,
      params,
      query,
      get body() {
        return ensureBody();
      },
      set body(v: any) {
        bodyConsumed = true;
        bodyResolved = v;
      },
      rawBody: undefined,
      // Original Web Request — exposed under a non-`raw` key so it doesn't
      // collide with Nest core's Fastify-style `(req as any).raw || req`
      // fallback used in router-execution-context.ts (SSE / render paths).
      bunRequest: bunReq as Request,
      get(name: string) {
        return headers[name.toLowerCase()];
      },
      header(name: string) {
        return headers[name.toLowerCase()];
      },
      on: reqEmitter.on.bind(reqEmitter),
      once: reqEmitter.once.bind(reqEmitter),
      off: reqEmitter.off.bind(reqEmitter),
      removeListener: reqEmitter.off.bind(reqEmitter),
      emit: reqEmitter.emit.bind(reqEmitter),
      // SseStream's commitHeaders touches `req.socket.setKeepAlive/setNoDelay`
      // — provide a no-op socket so it doesn't crash.
      socket: NOOP_SOCKET,
    };
    return req as BunRequest;
  }

  // ---------- runtime fetch dispatcher ----------
  private async handle(rawReq: Request, bunServer?: any): Promise<Response> {
    // Cheap pathname/search split — avoids constructing a `URL` per request
    // for the common case of an absolute "http://host/path?q=1" URL.
    const rawUrl = rawReq.url;
    const protoEnd = rawUrl.indexOf('://');
    const pathStart = protoEnd === -1 ? 0 : rawUrl.indexOf('/', protoEnd + 3);
    const queryStart = rawUrl.indexOf('?', pathStart === -1 ? 0 : pathStart);
    const pathname =
      pathStart === -1
        ? '/'
        : queryStart === -1
          ? rawUrl.slice(pathStart)
          : rawUrl.slice(pathStart, queryStart);
    const hasQuery = queryStart !== -1;

    if (rawReq.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      // wsPaths keys are stored normalized (ws-adapter's normalizePath strips a
      // trailing slash); normalize the lookup the same way so `/ws/` matches the
      // `/ws` gateway — matching standalone-port behaviour. `toBunRoutePath` is
      // the equivalent normaliser already in this module.
      const matched = this.wsPaths.get(toBunRoutePath(pathname));
      if (matched && bunServer) {
        const client = new (matched as any).clientClass(null);
        client.pattern = matched.path;
        const upgraded = bunServer.upgrade(rawReq, {
          data: { client, server: matched },
        });
        if (upgraded) return undefined as any;
      }
    }

    const req = await this.toBunRequest(rawReq, pathname, hasQuery, rawUrl, queryStart);

    return new Promise<Response>(resolve => {
      const res = makeBunResponse(this, req, resolve);

      if (this.corsOptions) {
        this.applyCorsHeaders(req, res);
        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          return this.end(res);
        }
      }

      // 1. static assets fast-path (only GET/HEAD, only if any registered)
      if (
        this.staticAssets.length !== 0 &&
        (req.method === 'GET' || req.method === 'HEAD')
      ) {
        const matched = this.matchStatic(pathname);
        if (matched) {
          this.serveStatic(matched, req, res).catch(err => res._reject(err));
          return;
        }
      }

      // 2. fast path — no global middleware: skip the Promise/await chain.
      if (this.router.middleware.length === 0) {
        const matches = this.router.matchAll(req.method, pathname);
        if (matches.length === 0) {
          return this.dispatchNotFound(req, res, resolve);
        }
        this.runRouteChain(matches, req, res, () => {
          if (!res.finished) this.dispatchNotFound(req, res, resolve);
        });
        return;
      }

      // 3. middleware path — middleware runs FIRST (it may handle the
      // request itself, e.g. Apollo's `app.use('/graphql', expressMiddleware)`
      // owns every `/graphql` request and never matches a Nest route).
      // Only after middleware finishes without writing the response do we
      // dispatch routes / 404.
      this.runGlobalMiddleware(req, res)
        .then(() => {
          if (res.finished) return;
          const matches = this.router.matchAll(req.method, pathname);
          if (matches.length === 0) {
            return this.dispatchNotFound(req, res, resolve);
          }
          this.runRouteChain(matches, req, res, () => {
            if (!res.finished) this.dispatchNotFound(req, res, resolve);
          });
        })
        .catch(err => {
          if (this.errorHandler) {
            try {
              this.errorHandler(err, req, res, () => res._reject(err));
            } catch (e2) {
              res._reject(e2);
            }
          } else {
            res._reject(err);
          }
        });
    });
  }

  private async runGlobalMiddleware(req: BunRequest, res: BunResponse) {
    for (const mw of this.router.middleware) {
      if (mw.prefix !== '/' && !req.path.startsWith(mw.prefix)) continue;
      if (res.finished) return;
      await new Promise<void>((resolveStep, rejectStep) => {
        try {
          const ret = mw.handler(req, res, (err?: any) => {
            if (err) rejectStep(err);
            else resolveStep();
          });
          if (ret && typeof (ret as any).then === 'function') {
            (ret as Promise<any>).then(() => resolveStep(), rejectStep);
          }
        } catch (e) {
          rejectStep(e);
        }
      });
    }
  }

  private runRouteChain(
    matches: { route: CompiledRoute; params: Record<string, string> }[],
    req: BunRequest,
    res: BunResponse,
    onExhausted: () => void,
  ) {
    let idx = 0;
    const step = (err?: any) => {
      if (err) {
        if (this.errorHandler) {
          try {
            return this.errorHandler(err, req, res, () => res._reject(err));
          } catch (e2) {
            return res._reject(e2);
          }
        }
        return res._reject(err);
      }
      if (res.finished) return;
      if (idx >= matches.length) return onExhausted();
      const { route, params } = matches[idx++];
      req.params = params;
      try {
        const ret = route.handler(req, res, step);
        if (ret && typeof (ret as any).then === 'function') {
          (ret as Promise<any>).catch(step);
        }
      } catch (e) {
        step(e);
      }
    };
    step();
  }

  private dispatchNotFound(
    req: BunRequest,
    res: BunResponse,
    resolve: (response: Response) => void,
  ) {
    if (this.notFoundHandler) {
      try {
        Promise.resolve(this.notFoundHandler(req, res, () => {})).catch(err =>
          res._reject(err),
        );
        return;
      } catch (err) {
        return res._reject(err);
      }
    }
    res.statusCode = 404;
    res.headers['content-type'] = 'application/json; charset=utf-8';
    res.finished = true;
    res.headersSent = true;
    resolve(
      new Response(
        '{"statusCode":404,"message":"Not Found"}',
        toResponseInit(res.headers, 404),
      ),
    );
  }

  private matchStatic(pathname: string): {
    entry: StaticEntry;
    relPath: string;
  } | null {
    for (const entry of this.staticAssets) {
      const prefix = entry.prefix === '/' ? '' : entry.prefix;
      if (prefix) {
        // Boundary-aware prefix match: `/static` must match `/static`,
        // `/static/`, `/static/foo`, but NOT `/static-admin/foo`.
        if (!pathname.startsWith(prefix)) continue;
        const next = pathname.charCodeAt(prefix.length);
        // 0x2F = '/'.  NaN means we're at the end of the string (exact match).
        if (!Number.isNaN(next) && next !== 0x2f) continue;
      }
      let rel = pathname.slice(prefix.length) || '/';
      if (rel.endsWith('/')) rel += entry.index;
      return { entry, relPath: rel };
    }
    return null;
  }

  private async serveStatic(
    matched: { entry: StaticEntry; relPath: string },
    _req: BunRequest,
    res: BunResponse,
  ) {
    const safe = normalize(matched.relPath).replace(/^[/\\]+/, '');
    if (safe.includes('..' + sep) || safe === '..') {
      res.statusCode = 403;
      this.end(res);
      return;
    }
    const filePath = join(matched.entry.root, safe);
    try {
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        res.statusCode = 404;
        this.end(res);
        return;
      }
      const file = (globalThis as any).Bun?.file
        ? (globalThis as any).Bun.file(filePath)
        : null;
      if (!file) {
        res.statusCode = 500;
        this.end(res);
        return;
      }
      const ext = extname(filePath).toLowerCase();
      const mime = STATIC_MIME[ext] ?? 'application/octet-stream';
      res.headers['content-type'] = mime;
      res.headers['content-length'] = String(stat.size);
      res.finished = true;
      res.headersSent = true;
      res._resolve(
        new Response(file as any, toResponseInit(res.headers, res.statusCode || 200)),
      );
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        res.statusCode = 404;
        this.end(res);
      } else {
        res._reject(err);
      }
    }
  }

  private async toBunRequest(
    raw: Request,
    pathname: string,
    hasQuery: boolean,
    rawUrl: string,
    queryStart: number,
  ): Promise<BunRequest> {
    const method = raw.method;
    const headers: Record<string, string> = Object.create(null);
    raw.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // Parse query lazily — most hot-path GET handlers don't read it.
    let query: Record<string, string | string[]> = EMPTY_QUERY;
    if (hasQuery) {
      query = Object.create(null);
      const search = rawUrl.slice(queryStart + 1);
      const params = new URLSearchParams(search);
      params.forEach((value, key) => {
        const existing = query[key];
        if (existing === undefined) query[key] = value;
        else if (Array.isArray(existing)) existing.push(value);
        else query[key] = [existing, value];
      });
    }

    let body: any = undefined;
    let rawBody: Buffer | undefined;
    const ctype = headers['content-type'] ?? '';
    // Skip multipart consumption — BunFileInterceptor will read formData()
    // off the original Web Request itself. Mirrors maybeParseBody() in the
    // routes hot path so behaviour is identical regardless of dispatcher.
    if (
      this.bodyParserEnabled &&
      method !== 'GET' &&
      method !== 'HEAD' &&
      raw.body &&
      !ctype.startsWith('multipart/')
    ) {
      // JSON fast path: defer to Bun's native parser, no Buffer/string
      // intermediates. Mirrors the routes-hot-path optimisation.
      if (!this.rawBodyEnabled && ctype.includes('application/json')) {
        try {
          body = await raw.json();
        } catch {
          body = undefined;
        }
      } else {
        const buf = Buffer.from(await raw.arrayBuffer());
        rawBody = buf;
        if (buf.length === 0) {
          body = undefined;
        } else if (ctype.includes('application/json')) {
          try {
            body = JSON.parse(buf.toString('utf8'));
          } catch {
            body = undefined;
          }
        } else if (ctype.includes('application/x-www-form-urlencoded')) {
          body = Object.fromEntries(new URLSearchParams(buf.toString('utf8')));
        } else if (ctype.startsWith('text/')) {
          body = buf.toString('utf8');
        } else {
          body = buf;
        }
      }
    }

    const hostHeader = headers['host'];
    const hostname = hostHeader ? hostHeader.split(':', 1)[0] : '';
    const fullPath = hasQuery ? rawUrl.slice(rawUrl.indexOf(pathname)) : pathname;

    const req: BunRequest = {
      method,
      url: fullPath,
      originalUrl: fullPath,
      baseUrl: '',
      path: pathname,
      hostname,
      ip: headers['x-forwarded-for']?.split(',', 1)[0].trim() ?? '127.0.0.1',
      headers,
      params: EMPTY_PARAMS,
      query,
      body,
      rawBody,
      bunRequest: raw,
      get(name: string) {
        return this.headers[name.toLowerCase()];
      },
      header(name: string) {
        return this.headers[name.toLowerCase()];
      },
    };
    return req;
  }

  private applyCorsHeaders(req: BunRequest, res: BunResponse) {
    if (!this.corsOptions) return;
    const opts = this.corsOptions === true ? {} : this.corsOptions;
    const h = res.headers;
    const reqOrigin = req.headers['origin'];

    // Resolve `origin` to a concrete header value.
    // Semantics match @nestjs/platform-express + the `cors` package:
    //   * `string`         → echoed verbatim
    //   * `string[]`       → echo request origin if it's in the list, else omit
    //   * `RegExp`         → echo request origin if it matches, else omit
    //   * `true`           → echo the request's Origin (or '*' if absent),
    //                        which is also required when `credentials: true`
    //                        because browsers reject `*` in that combination.
    //   * `function(req)`  → invoked with the request, return value is treated
    //                        as one of the above. Async forms are not supported
    //                        in this minimal pilot.
    //   * `undefined`/'*'  → '*' unless `credentials: true`, in which case we
    //                        echo the request's Origin so the browser accepts it.
    const rawOrigin = opts.origin ?? '*';
    const credentials = !!opts.credentials;
    const wantsEcho = credentials && (rawOrigin === '*' || rawOrigin === true);

    let originHeader: string | undefined;
    if (typeof rawOrigin === 'function') {
      try {
        const resolved = rawOrigin(req);
        if (typeof resolved === 'string') originHeader = resolved;
        else if (resolved === true) originHeader = reqOrigin ?? '*';
        // false / null → don't emit the header.
      } catch {
        // swallow — caller's CORS function shouldn't break the response.
      }
    } else if (rawOrigin === true) {
      originHeader = reqOrigin ?? '*';
    } else if (Array.isArray(rawOrigin)) {
      if (
        reqOrigin &&
        rawOrigin.some(o => (o instanceof RegExp ? o.test(reqOrigin) : o === reqOrigin))
      ) {
        originHeader = reqOrigin;
      }
    } else if (rawOrigin instanceof RegExp) {
      if (reqOrigin && rawOrigin.test(reqOrigin)) originHeader = reqOrigin;
    } else if (typeof rawOrigin === 'string') {
      originHeader = wantsEcho ? (reqOrigin ?? '*') : rawOrigin;
    }

    if (originHeader !== undefined) {
      h['access-control-allow-origin'] = originHeader;
      // Tell intermediaries the response varies by Origin whenever it's
      // request-dependent, so caches don't poison cross-origin clients.
      if (originHeader !== '*') {
        const existingVary = h['vary'];
        h['vary'] = existingVary
          ? Array.isArray(existingVary)
            ? [...existingVary, 'Origin']
            : `${existingVary}, Origin`
          : 'Origin';
      }
    }

    h['access-control-allow-methods'] = Array.isArray(opts.methods)
      ? opts.methods.join(',')
      : (opts.methods ?? 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
    if (credentials) h['access-control-allow-credentials'] = 'true';
    if (opts.allowedHeaders) {
      h['access-control-allow-headers'] = Array.isArray(opts.allowedHeaders)
        ? opts.allowedHeaders.join(',')
        : opts.allowedHeaders;
    } else {
      const reqHeaders = req.headers['access-control-request-headers'];
      if (reqHeaders) h['access-control-allow-headers'] = reqHeaders;
    }
    if (opts.exposedHeaders) {
      h['access-control-expose-headers'] = Array.isArray(opts.exposedHeaders)
        ? opts.exposedHeaders.join(',')
        : opts.exposedHeaders;
    }
    if (opts.maxAge !== undefined) {
      h['access-control-max-age'] = String(opts.maxAge);
    }
  }
}

function makeBunResponse(
  adapter: BunHttpAdapter,
  req: BunRequest,
  resolve: (r: Response) => void,
): BunResponse {
  const res: BunResponse = {
    statusCode: 200,
    headers: Object.create(null) as BunResponseHeaders,
    body: undefined,
    headersSent: false,
    finished: false,
    _resolve: resolve,
    _reject(err: any) {
      if (this.finished) return;
      this.finished = true;
      this.headersSent = true;
      resolve(
        Response.json(
          {
            statusCode: 500,
            message: err?.message ?? 'Internal Server Error',
          },
          { status: 500 },
        ),
      );
    },
    req,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(body?: any) {
      adapter.reply(this, body);
      return this;
    },
    json(body: any) {
      this.headers['content-type'] = 'application/json; charset=utf-8';
      adapter.reply(this, body);
      return this;
    },
    end(message?: string) {
      adapter.end(this, message);
      return this;
    },
    redirect(urlOrStatus: number | string, maybeUrl?: string) {
      let status = 302;
      let url: string;
      if (typeof urlOrStatus === 'number') {
        status = urlOrStatus;
        url = maybeUrl as string;
      } else {
        url = urlOrStatus;
      }
      adapter.redirect(this, status, url);
      return this;
    },
    set(name: string, value?: string) {
      if (typeof name === 'object') {
        for (const [k, v] of Object.entries(name as any)) {
          this.headers[k.toLowerCase()] = String(v);
        }
      } else {
        this.headers[name.toLowerCase()] = String(value);
      }
      return this;
    },
    header(name: string, value?: string) {
      return this.set(name, value);
    },
    get(name: string) {
      const v = this.headers[name.toLowerCase()];
      return Array.isArray(v) ? v.join(', ') : v;
    },
    type(contentType: string) {
      this.headers['content-type'] = contentType;
      return this;
    },
  };
  attachWritableShim(res, resolve);
  return res;
}

/**
 * Add Node `Writable`-shaped methods to BunResponse so Nest's
 * `RouterResponseController.sse()` (which pipes a `SseStream` into the
 * response) sees a familiar contract: `writeHead`, `flushHeaders`, `write`,
 * `end`, `writableEnded`, plus EventEmitter methods. Until any of those is
 * actually called, the response stays in the cheap buffered mode.
 */
function attachWritableShim(res: BunResponse, resolve: (r: Response) => void): void {
  let streamCtrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const emitter = new EventEmitter();

  const ensureStreaming = () => {
    if (streamCtrl) return;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        streamCtrl = c;
      },
    });
    res.headersSent = true;
    resolve(new Response(stream, toResponseInit(res.headers, res.statusCode || 200)));
  };

  const r = res as any;
  r.write = (chunk: any, encodingOrCb?: any, cb?: (err?: Error | null) => void) => {
    let callback = cb;
    if (typeof encodingOrCb === 'function') callback = encodingOrCb;
    if (r.finished) {
      callback?.(new Error('write after end'));
      return false;
    }
    ensureStreaming();
    try {
      let buf: Uint8Array;
      if (chunk instanceof Uint8Array) buf = chunk;
      else if (typeof chunk === 'string') buf = new TextEncoder().encode(chunk);
      else if (Buffer.isBuffer(chunk)) buf = new Uint8Array(chunk);
      else buf = new TextEncoder().encode(String(chunk));
      streamCtrl!.enqueue(buf);
    } catch (err) {
      callback?.(err as Error);
      return false;
    }
    callback?.();
    return true;
  };

  r.end = (chunk?: any, encodingOrCb?: any, cb?: (err?: Error | null) => void) => {
    let callback = cb;
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = undefined;
    } else if (typeof encodingOrCb === 'function') {
      callback = encodingOrCb;
    }
    if (r.finished) {
      callback?.();
      return r;
    }
    if (streamCtrl) {
      // Already in streaming mode — flush remaining chunk + close.
      if (chunk !== undefined) r.write(chunk);
      try {
        streamCtrl.close();
      } catch {}
    } else {
      // Non-streaming path: resolve a single buffered Response.
      r.finished = true;
      r.headersSent = true;
      resolve(
        new Response(chunk ?? null, toResponseInit(r.headers, r.statusCode || 200)),
      );
    }
    r.finished = true;
    r.headersSent = true;
    emitter.emit('finish');
    emitter.emit('close');
    callback?.();
    return r;
  };

  r.writeHead = (
    statusCode: number,
    statusMessageOrHeaders?: any,
    maybeHeaders?: any,
  ) => {
    r.statusCode = statusCode;
    let headers = maybeHeaders;
    if (typeof statusMessageOrHeaders === 'object' && statusMessageOrHeaders !== null) {
      headers = statusMessageOrHeaders;
    }
    if (headers) {
      for (const [k, v] of Object.entries(headers as any)) {
        r.headers[k.toLowerCase()] = Array.isArray(v) ? (v as string[]) : String(v);
      }
    }
    ensureStreaming();
    return r;
  };

  r.flushHeaders = () => {
    ensureStreaming();
    return r;
  };

  // Node-style header API. Express middleware (e.g. Apollo's
  // `expressMiddleware`) calls `res.setHeader` directly instead of going
  // through `res.set` / `res.header`.
  r.setHeader = (name: string, value: string | string[] | number) => {
    r.headers[String(name).toLowerCase()] = Array.isArray(value)
      ? (value as string[])
      : String(value);
    return r;
  };
  r.getHeader = (name: string) => {
    return r.headers[String(name).toLowerCase()];
  };
  r.removeHeader = (name: string) => {
    delete r.headers[String(name).toLowerCase()];
  };

  Object.defineProperty(r, 'writableEnded', {
    get() {
      return r.finished;
    },
    configurable: true,
  });
  Object.defineProperty(r, 'destroyed', {
    get() {
      return r.finished;
    },
    configurable: true,
  });

  r.on = emitter.on.bind(emitter);
  r.once = emitter.once.bind(emitter);
  r.off = emitter.off.bind(emitter);
  r.removeListener = emitter.off.bind(emitter);
  r.emit = emitter.emit.bind(emitter);
}

/**
 * Eager headers map — Bun's `Headers.forEach()` is a tight native loop (5-15
 * entries for a normal request, ~200 ns total) and produces a Proxy-free
 * plain object that JIT can optimise inline-cache against. Replaces an
 * earlier `Proxy(Headers)` shim whose per-trap `.get()` overhead beat the
 * upfront copy as soon as any handler read more than one header.
 *
 * Keys are normalised to lowercase since Bun's `Headers` already iterates
 * in canonical lowercase form.
 */
// SseStream pokes these on `req.socket`; nothing to do under Bun.
const NOOP_SOCKET = Object.freeze({
  setKeepAlive: () => {},
  setNoDelay: () => {},
  setTimeout: () => {},
});

function isStreamableFile(value: any): boolean {
  // duck-type check — avoids importing the class so we don't pin the import
  // graph and keep the adapter functional even when @nestjs/common doesn't
  // ship the file-stream module yet.
  return typeof value.getStream === 'function' && typeof value.getHeaders === 'function';
}

function nodeReadableToWeb(nodeStream: any): ReadableStream {
  return new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk: any) => {
        controller.enqueue(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk));
      });
      nodeStream.once('end', () => controller.close());
      nodeStream.once('error', (err: any) => controller.error(err));
    },
    cancel() {
      nodeStream.destroy?.();
    },
  });
}

function buildHeaders(rawHeaders: Headers): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  rawHeaders.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function parseQuery(search: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = Object.create(null);
  const params = new URLSearchParams(search);
  params.forEach((value, key) => {
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  });
  return out;
}

function toBunRoutePath(path: string): string {
  // Bun.serve route syntax accepts `:param` and `*` directly. Normalise empty
  // path to `/` and strip trailing slash for consistency.
  if (!path) return '/';
  if (!path.startsWith('/')) path = '/' + path;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};
