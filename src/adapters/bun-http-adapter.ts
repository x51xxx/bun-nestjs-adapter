import { extname, join } from 'path';
import {
  BadRequestException,
  Logger,
  RequestMethod,
  VersioningOptions,
} from '@nestjs/common';
// Nest 12 added an `exports` map to @nestjs/common where `./*` resolves to
// `./*.js`, so the bare `@nestjs/common/interfaces` directory import no longer
// resolves (only `interfaces/index.js` exists on disk). These concrete files
// resolve on 10, 11 and 12 alike; `VersionValue` can't come off the package
// root either — it lives in `@nestjs/common/internal`, which 10/11 lack.
import { NestApplicationOptions } from '@nestjs/common/interfaces/nest-application-options.interface';
import { VersionValue } from '@nestjs/common/interfaces/version-options.interface';
import { AbstractHttpAdapter } from '@nestjs/core';
import { CorsOptions, applyCorsHeaders } from '../http/cors';
import {
  RequestShimContext,
  buildFetchRequest,
  buildNativeRouteRequest,
  maybeParseBody,
} from '../http/request';
import { NodeWritableShim, makeBunResponse, toResponseInit } from '../http/response';
import {
  BunRouterInstance,
  CompiledRoute,
  bunRoutesLoseParams,
  isBunNativeMethod,
  matchesPathPrefix,
  toBunRoutePath,
} from '../http/router';
import { BunHttpServer, BunNativeRouteHandler, BunNativeRoutes } from '../http/server';
import {
  StaticEntry,
  StaticMatch,
  bunDirRoutePath,
  matchStatic,
  serveNativeStatic,
  serveStatic,
} from '../http/static';
import {
  StreamableLike,
  isNodeReadable,
  isStreamableFile,
  streamNodeReadable,
} from '../http/streaming';
import {
  BunErrorHandler,
  BunRequest,
  BunResponse,
  BunRouteHandler,
  BunServer,
  WsServerShim,
} from '../http/types';
import { applyVersionFilter } from '../http/versioning';
import { renderTemplate } from '../http/views';

export type { BunRequest, BunResponse, BunResponseHeaders } from '../http/types';
export type { CorsOptions } from '../http/cors';

interface ServeStaticOptions {
  root?: string;
  prefix?: string;
  index?: string;
  /**
   * Serve this root through Bun's native `{ dir }` route (Bun >= 1.4.0).
   *
   * Off by default because it changes observable behaviour — see
   * `serveNativeStatic` and `docs/http.md`. What it buys: a static
   * root no longer forces the whole app onto the manual `fetch` dispatcher,
   * and files come back with `ETag` / `Last-Modified` / conditional 304.
   */
  native?: boolean;
}

/** `{ dir }` routes landed in Bun 1.4.0; older runtimes throw on the option. */
function supportsNativeDirRoutes(): boolean {
  if (typeof Bun === 'undefined' || typeof Bun.semver?.satisfies !== 'function')
    return false;
  return Bun.semver.satisfies(Bun.version, '>=1.4.0');
}

function isThenable(value: unknown): value is Promise<unknown> {
  return !!value && typeof (value as { then?: unknown }).then === 'function';
}

/**
 * @publicApi
 */
export class BunHttpAdapter extends AbstractHttpAdapter<
  BunHttpServer,
  BunRequest,
  BunResponse
> {
  /**
   * Request-shim flags shared with the builders in `http/request.ts`.
   * `rawBodyEnabled` is only set with Nest's `rawBody: true` — without it the
   * JSON fast path hands bytes straight to Bun's native parser.
   */
  private readonly shimCtx: RequestShimContext = {
    bodyParserEnabled: false,
    rawBodyEnabled: false,
    cookieSecret: null,
    trustProxy: false,
  };
  private corsOptions: CorsOptions | null = null;
  private notFoundHandler: BunRouteHandler | null = null;
  private errorHandler: BunErrorHandler | null = null;
  /** Nest's `forceCloseConnections`: close() drops open connections. */
  private forceCloseConnections = false;
  private readonly router = new BunRouterInstance();
  private readonly staticAssets: StaticEntry[] = [];
  private readonly logger = new Logger(BunHttpAdapter.name);
  public readonly wsPaths = new Map<string, WsServerShim>();
  private viewEngine: string | null = null;
  private viewsDir = join(process.cwd(), 'views');

  public get cookieSecret(): string | null {
    return this.shimCtx.cookieSecret;
  }

  constructor() {
    super(undefined);
    this.setInstance(this.router);
  }

  public override async init() {}

  public initHttpServer(options: NestApplicationOptions): void {
    this.forceCloseConnections = options?.forceCloseConnections === true;
    const server = new BunHttpServer((req, bunServer) => this.handle(req, bunServer));
    const https = options?.httpsOptions;
    if (https) {
      // Forward the options object wholesale — Bun.serve({ tls }) understands
      // the common Node TLS fields (requestCert, rejectUnauthorized, ciphers,
      // secureOptions, serverName, ALPN, …); whitelisting key/cert here would
      // silently drop mTLS and TLS-hardening settings.
      server.tls = https;
    }
    (server as BunHttpServer & { adapter: BunHttpAdapter }).adapter = this;
    this.setHttpServer(server);
  }

  public override listen(
    port: string | number,
    hostnameOrCb?: string | ((err?: Error) => void),
    cb?: (err?: Error) => void,
  ) {
    // Build native Bun.serve `routes` ONLY when there is no fast-path-blocking
    // feature in use. Middleware / static / CORS / version filters all fall
    // back to the manual `fetch` dispatcher because Bun.routes can't model
    // multi-match `next()`-chaining or path-prefix middleware.
    // notFoundHandler is OK to coexist with native routes — when no route
    // matches, Bun.serve falls through to the `fetch` callback, which still
    // runs our `handle()` and ends in dispatchNotFound().
    if (this.canUseNativeRoutes()) {
      this.httpServer.routes = this.buildBunRoutes();
    }
    const server = this.httpServer.listen(port, hostnameOrCb, cb);
    const nativeServer = this.httpServer.bunServer;
    if (nativeServer) {
      for (const wsServer of this.wsPaths.values()) {
        wsServer.bunServer = nativeServer;
      }
    }
    return server;
  }

  private canUseNativeRoutes(): boolean {
    return (
      this.router.middleware.length === 0 &&
      // A native static root lives *on* the route map, so it no longer forces
      // the manual dispatcher; a classic one still does.
      this.staticAssets.every(entry => entry.native) &&
      this.corsOptions === null
    );
  }

  /** Build the `Bun.serve({ routes })` map from the adapter's collected paths. */
  private buildBunRoutes(): BunNativeRoutes {
    const out: BunNativeRoutes = {};
    for (const [path, methodMap] of this.router.byPath) {
      // Bun's matcher accepts `*name` but hands back an empty `params`, so a
      // named wildcard would silently lose its capture here while the manual
      // dispatcher resolves it correctly. Leaving the path out of the native
      // map makes Bun fall through to `fetch`, which routes it through our own
      // regex matcher — same handler, same params, on both paths.
      if (bunRoutesLoseParams(path)) continue;

      const bunPath = toBunRoutePath(path);
      const methodHandler: Record<string, BunNativeRouteHandler> = {};
      for (const [method, handlers] of methodMap) {
        // SEARCH, QUERY and the WebDAV verbs are not valid keys on a Bun route
        // object — see isBunNativeMethod(). Leaving them out drops them to the
        // `fetch` callback, which our manual dispatcher serves; keeping them in
        // would make `Bun.serve()` throw and take down `listen()`. `ALL` is
        // skipped here too and collapsed into a bare function route below.
        if (!isBunNativeMethod(method)) continue;
        // Keep a closure that reuses the prepared handler list. For a single
        // handler we run it directly; for many (versioning, ALL+specific)
        // we walk the chain with `next()` semantics. Either way, returning
        // `undefined` from the route handler triggers Bun to fall through
        // to the `fetch` callback (which then renders our 404 JSON).
        if (handlers.length === 1) {
          const h = handlers[0];
          methodHandler[method] = (req, server) => this.runBunRouteSingle(req, h, server);
        } else {
          methodHandler[method] = (req, server) =>
            this.runBunRouteChain(req, handlers, server);
        }
      }
      // HEAD falls back to the GET handler, matching Express and Fastify.
      // Bun strips the body from a HEAD response itself, so the handler needs
      // no special casing — health checks and `curl -I` used to get a 404.
      if (!methodHandler.HEAD && methodMap.has('GET')) {
        methodHandler.HEAD = methodHandler.GET;
      }

      // ALL handlers are invoked for any method that has no explicit entry.
      const allHandlers = methodMap.get('ALL');
      if (allHandlers && allHandlers.length) {
        // Collapse ALL into the wildcard form Bun expects (default route), and
        // rebuild the chain in *registration* order. Concatenating
        // `[...methodSpecific, ...allHandlers]`, as this used to, ran every
        // `@Get()` before every `@All()` on the same path no matter how they
        // were declared — while the manual dispatcher interleaved them
        // correctly, so the two disagreed. Memoised per verb; `reloadRoutes()`
        // rebuilds this closure whenever a route is added.
        const queues = new Map<string, BunRouteHandler[]>();
        out[bunPath] = (req, server) => {
          let queue = queues.get(req.method);
          if (queue === undefined) {
            queue = this.router.orderedHandlers(path, req.method);
            queues.set(req.method, queue);
          }
          return this.runBunRouteChain(req, queue, server);
        };
      } else if (Object.keys(methodHandler).length > 0) {
        out[bunPath] = methodHandler;
      }
      // A path whose only verbs are non-native (e.g. `@Search()` alone) stays
      // off the map entirely — an empty route object would claim the path
      // without being able to serve any method on it.
    }

    // Native static roots are part of the map, so they survive every rebuild
    // (a route registered after `listen()` triggers `reloadRoutes()`), and a
    // real route always wins the key — Bun's matcher already prefers the more
    // specific pattern, so leaving an explicit route in place keeps the two
    // dispatchers agreeing about who owns the path.
    for (const entry of this.staticAssets) {
      if (!entry.native) continue;
      const dirPath = bunDirRoutePath(entry.prefix);
      if (dirPath in out) continue;
      out[dirPath] = { dir: entry.root };
    }
    return out;
  }

  public close() {
    return new Promise<void>(resolve => {
      if (!this.httpServer) return resolve();
      // Without `forceCloseConnections`, Bun's stop() waits for in-flight
      // responses — an open SSE / streaming response keeps close() pending
      // until the client leaves, as express does. With it, stop(true) drops
      // the connections, matching express's tracked-socket teardown.
      this.httpServer.close(() => resolve(), this.forceCloseConnections);
    });
  }

  public getType(): string {
    return 'bun';
  }

  // ---------- routing methods ----------
  public override get(...args: unknown[]) {
    return this.registerRoute('GET', args);
  }
  public override post(...args: unknown[]) {
    return this.registerRoute('POST', args);
  }
  public override put(...args: unknown[]) {
    return this.registerRoute('PUT', args);
  }
  public override delete(...args: unknown[]) {
    return this.registerRoute('DELETE', args);
  }
  public override patch(...args: unknown[]) {
    return this.registerRoute('PATCH', args);
  }
  public override head(...args: unknown[]) {
    return this.registerRoute('HEAD', args);
  }
  public override options(...args: unknown[]) {
    return this.registerRoute('OPTIONS', args);
  }
  public override all(...args: unknown[]) {
    return this.registerRoute('ALL', args);
  }
  public override search(...args: unknown[]) {
    return this.registerRoute('SEARCH', args);
  }
  // The QUERY verb landed in Nest 12. Without this override the base
  // `AbstractHttpAdapter.query()` delegates to `this.instance.query(...)` —
  // and our `instance` is `undefined`, so a single `@QueryMethod()` route
  // crashed the whole bootstrap instead of registering.
  public override query(...args: unknown[]) {
    return this.registerRoute('QUERY', args);
  }
  public override use(...args: unknown[]) {
    let prefix = '/';
    let handler: unknown;
    if (typeof args[0] === 'string') {
      prefix = args[0];
      handler = args[1];
    } else {
      handler = args[0];
    }
    if (typeof handler !== 'function') return;
    this.router.use(prefix, handler as BunRouteHandler);
    if (this.httpServer?.listening) {
      this.reloadRoutes();
    }
  }

  private registerRoute(method: string, args: unknown[]) {
    let path = '/';
    let handler: unknown;
    if (typeof args[0] === 'string' || args[0] instanceof RegExp) {
      path = String(args[0]);
      handler = args[1];
    } else {
      handler = args[0];
    }
    if (typeof handler !== 'function') return;
    this.router.add(method, path, handler as BunRouteHandler);
    if (this.httpServer?.listening) {
      this.reloadRoutes();
    }
  }

  private reloadRoutes() {
    if (!this.httpServer?.bunServer) return;
    if (this.canUseNativeRoutes()) {
      this.httpServer.applyRoutes(this.buildBunRoutes());
    } else {
      this.httpServer.applyRoutes(undefined);
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

  public reply(response: BunResponse, body: unknown, statusCode?: number) {
    if (response.finished) return;
    if (statusCode !== undefined) response.statusCode = statusCode;

    // Handler already called `res.write()` — headers are on the wire and the
    // buffered path can no longer settle anything. Append and close instead of
    // silently dropping the body (which is what a second `_resolve` did).
    if (response._streaming === true) {
      const w = response as BunResponse & NodeWritableShim;
      response.body = body;
      if (body !== undefined && body !== null) {
        w.write(
          typeof body === 'string' || body instanceof Uint8Array
            ? body
            : JSON.stringify(body),
        );
      }
      w.end();
      return;
    }

    if (body !== null && typeof body === 'object') {
      // StreamableFile — Nest's wrapper around a Node Readable stream.
      // Convert to a web ReadableStream and stream it back through Bun.serve.
      if (isStreamableFile(body)) {
        this.replyStreamable(response, body);
        return;
      }
      // Bare Node Readable — also convert to web stream.
      if (isNodeReadable(body)) {
        if (response.headers['content-type'] === undefined) {
          response.headers['content-type'] = 'application/octet-stream';
        }
        streamNodeReadable(response, body);
        return;
      }
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
      // A handler can hand back a web stream directly, bypassing both the
      // writable shim and `streamNodeReadable` — it still needs the idle timer
      // off, or Bun cuts it after 10 s of quiet. `Uint8Array`/`ArrayBuffer`/
      // `Blob` are complete data; only the stream can sit idle.
      if (body instanceof ReadableStream) response._disableIdleTimeout?.();
      response.body = body;
      response.finished = true;
      response.headersSent = true;
      response._resolve(
        new Response(
          body as BodyInit,
          toResponseInit(response.headers, response.statusCode),
        ),
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

  private replyStreamable(response: BunResponse, file: StreamableLike) {
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
    streamNodeReadable(response, file.getStream());
  }

  public end(response: BunResponse, message?: string) {
    if (response.finished) return;
    if (response._streaming === true) {
      (response as BunResponse & NodeWritableShim).end(message);
      return;
    }
    response.finished = true;
    response.headersSent = true;
    response._resolve(
      new Response(
        message ?? null,
        toResponseInit(response.headers, response.statusCode),
      ),
    );
  }

  public render(response: BunResponse, view: string, options: object) {
    if (!this.viewEngine) {
      throw new Error(
        'platform-bun: View engine is not configured. Call setViewEngine() first.',
      );
    }
    const ext = extname(view) ? '' : `.${this.viewEngine}`;
    const filePath = join(this.viewsDir, `${view}${ext}`);
    renderTemplate(this.viewEngine, filePath, options)
      .then(html => {
        response.headers['content-type'] = 'text/html; charset=utf-8';
        this.reply(response, html);
      })
      .catch(err => {
        response._reject(err);
      });
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
    this.errorHandler = handler as BunErrorHandler;
  }
  public setNotFoundHandler(handler: Function, _prefix?: string) {
    this.notFoundHandler = handler as BunRouteHandler;
  }

  public useStaticAssets(
    rootOrOptions: string | ServeStaticOptions,
    maybeOptions?: ServeStaticOptions,
  ) {
    let root: string | undefined;
    let options: ServeStaticOptions;
    if (typeof rootOrOptions === 'string') {
      root = rootOrOptions;
      options = maybeOptions ?? {};
    } else {
      root = rootOrOptions?.root;
      options = rootOrOptions ?? {};
    }
    if (!root) return;
    let native = options.native === true;
    if (native && !supportsNativeDirRoutes()) {
      // Falling back keeps the app booting on an older runtime; throwing here
      // would turn a performance opt-in into a hard version requirement.
      this.logger.warn(
        `useStaticAssets({ native: true }) needs Bun >= 1.4.0, running ${
          typeof Bun === 'undefined' ? 'a non-Bun runtime' : Bun.version
        } — serving '${root}' the classic way instead.`,
      );
      native = false;
    }
    this.staticAssets.push({
      prefix: options.prefix ?? '/',
      root,
      index: options.index ?? 'index.html',
      native,
    });
    // A mount registered after `listen()` has to reach the live route map:
    // a native one belongs *in* it, and a classic one has to tear it down.
    if (this.httpServer?.listening) {
      this.reloadRoutes();
    }
  }

  public setViewEngine(engine: string) {
    this.viewEngine = engine;
    return this;
  }

  public setBaseViewsDir(path: string | string[]) {
    this.viewsDir = Array.isArray(path) ? path[0] : path;
    return this;
  }

  public registerParserMiddleware(_prefix?: string, rawBody?: boolean) {
    this.shimCtx.bodyParserEnabled = true;
    if (rawBody) this.shimCtx.rawBodyEnabled = true;
  }

  public enableCors(options?: CorsOptions, _prefix?: string) {
    this.corsOptions = options ?? {};
    // CORS forces the manual dispatcher, so a server already serving from the
    // native route map has to be moved off it — the same live rebuild `use()`
    // and `useStaticAssets()` do. Without this, `enableCors()` after `listen()`
    // set the options and changed nothing observable.
    if (this.httpServer?.listening) {
      this.reloadRoutes();
    }
  }

  /**
   * Opt in to deriving `req.ip` from the left-most `X-Forwarded-For` entry.
   * Equivalent to Express' `app.set('trust proxy', true)`. Off by default —
   * the header is client-supplied, so trusting it without a proxy in front
   * lets any caller forge the identity that rate limiters and audit logs key
   * on. With it off, `req.ip` is the real peer address from
   * `Bun.serve`'s `server.requestIP()`.
   */
  public setTrustProxy(trust = true) {
    this.shimCtx.trustProxy = trust;
    return this;
  }

  public enableCookieParser(secret?: string) {
    this.shimCtx.cookieSecret = secret || null;
    return this;
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
      this.router.use(prefix, callback as BunRouteHandler);
    };
  }

  public applyVersionFilter(
    handler: Function,
    version: VersionValue,
    versioningOptions: VersioningOptions,
  ) {
    // The base class types this as returning a curried `Function`; our
    // handlers return `unknown`, hence the single covariance cast.
    return applyVersionFilter(handler, version, versioningOptions) as (
      req: BunRequest,
      res: BunResponse,
      next: () => void,
    ) => Function;
  }

  // ---------- Bun-native routes hot path ----------
  /**
   * Single-handler Bun route — minimal allocation. Returns the Response that
   * the handler writes via `adapter.reply/end/redirect`; `undefined` for a
   * WS upgrade so Bun falls through to the `fetch` callback.
   */
  private runBunRouteSingle(
    bunReq: Request,
    handler: BunRouteHandler,
    server?: BunServer,
  ): Promise<Response> | undefined {
    if (bunReq.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      return undefined;
    }
    const req = buildNativeRouteRequest(bunReq, this.shimCtx, server);
    const m = req.method;
    // Hot path: GET/HEAD without body parser — skip the async wrapper entirely.
    if (m === 'GET' || m === 'HEAD' || !this.shimCtx.bodyParserEnabled) {
      return this.invokeSingle(req, handler, server);
    }
    return maybeParseBody(req, bunReq, this.shimCtx).then(() =>
      req.bodyParseError
        ? this.settleBodyParseError(req, server)
        : this.invokeSingle(req, handler, server),
    );
  }

  private invokeSingle(
    req: BunRequest,
    handler: BunRouteHandler,
    server?: BunServer,
  ): Promise<Response> {
    return new Promise<Response>(resolve => {
      const res = makeBunResponse(this, req, resolve, server);
      try {
        const ret = handler(req, res, (err?: unknown) => {
          // `next(err)` used to be swallowed here — the argument was ignored
          // and the request fell through to a 404. The manual dispatcher has
          // always routed it to the error handler; now both do.
          if (err) return this.dispatchError(err, req, res);
          if (!res.finished) this.dispatchNotFound(req, res);
        });
        if (isThenable(ret)) {
          // Through `dispatchError`, not straight to `_reject`: the manual
          // dispatcher consults the handler Nest registered with
          // `setErrorHandler()`, and the two paths have to render an escaped
          // error the same way.
          ret.catch(err => this.dispatchError(err, req, res));
        }
      } catch (e) {
        this.dispatchError(e, req, res);
      }
    });
  }

  /**
   * Multi-handler Bun route — for versioning / ALL fallthrough. Calls handlers
   * in order; if a handler invokes `next()`, the next candidate runs; if all
   * exhaust without writing a response we return 404.
   */
  private async runBunRouteChain(
    bunReq: Request,
    handlers: BunRouteHandler[],
    server?: BunServer,
  ): Promise<Response | undefined> {
    if (bunReq.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      return undefined;
    }
    const req = buildNativeRouteRequest(bunReq, this.shimCtx, server);
    await maybeParseBody(req, bunReq, this.shimCtx);
    if (req.bodyParseError) return this.settleBodyParseError(req, server);
    return new Promise<Response>(resolve => {
      const res = makeBunResponse(this, req, resolve, server);
      let idx = 0;
      const step = (err?: unknown) => {
        if (err) return this.dispatchError(err, req, res);
        if (res.finished) return;
        if (idx >= handlers.length) {
          return this.dispatchNotFound(req, res);
        }
        const h = handlers[idx++];
        try {
          const ret = h(req, res, step);
          if (isThenable(ret)) {
            ret.catch(step);
          }
        } catch (e) {
          step(e);
        }
      };
      step();
    });
  }

  // ---------- runtime fetch dispatcher ----------
  private async handle(rawReq: Request, bunServer?: BunServer): Promise<Response> {
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

    if (rawReq.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      // wsPaths keys are stored normalized (ws-adapter's normalizePath strips a
      // trailing slash); normalize the lookup the same way so `/ws/` matches the
      // `/ws` gateway — matching standalone-port behaviour.
      const matched = this.wsPaths.get(toBunRoutePath(pathname));
      if (matched && bunServer) {
        const client = new matched.clientClass(null);
        client.pattern = matched.path;
        const upgraded = bunServer.upgrade(rawReq, {
          data: { client, server: matched },
        });
        // Bun requires `undefined` (not a Response) after a successful upgrade.
        if (upgraded) return undefined as unknown as Response;
      }
    }

    // `req.url` must keep the query string. Slice from the path start instead
    // of `rawUrl.indexOf(pathname)` — for pathname '/' the latter found the
    // '//' of the protocol and produced urls like '//host/?q=1'.
    const fullPath =
      pathStart !== -1
        ? rawUrl.slice(pathStart)
        : queryStart !== -1
          ? '/' + rawUrl.slice(queryStart)
          : '/';

    const req = await buildFetchRequest(
      rawReq,
      pathname,
      fullPath,
      rawUrl,
      queryStart,
      this.shimCtx,
      bunServer,
    );

    return new Promise<Response>(resolve => {
      const res = makeBunResponse(this, req, resolve, bunServer);

      if (this.corsOptions) {
        // Every `OPTIONS` counts as a preflight — that is what `cors` (which
        // @nestjs/platform-express uses) and `@fastify/cors` both do; neither
        // sniffs `Access-Control-Request-Method` by default. The documented way
        // to let your own `@Options()` handler run is `preflightContinue`,
        // which applies the preflight headers and then falls through to normal
        // routing.
        const isPreflight = req.method === 'OPTIONS';
        applyCorsHeaders(req, res, this.corsOptions, isPreflight);
        if (isPreflight && this.corsOptions.preflightContinue !== true) {
          res.statusCode = this.corsOptions.optionsSuccessStatus ?? 204;
          // `cors` sets this because Safari hangs on a bodyless preflight
          // without it. Measured on Bun 1.4.0: Bun drops the header on a 204
          // (where the RFC forbids it) and keeps it on the 2xx an app picks via
          // `optionsSuccessStatus` — which is the case the workaround is for.
          res.headers['content-length'] = '0';
          return this.end(res);
        }
      }

      if (req.bodyParseError) {
        return this.dispatchError(
          new BadRequestException(req.bodyParseError.message),
          req,
          res,
        );
      }

      // 1. static assets.
      //
      // *Classic* roots are checked before route dispatch and only for
      // GET/HEAD. A miss inside serveStatic (file not found / directory) moves
      // on to the next mount that covers the path, and only when they are all
      // exhausted does route dispatch run — `serve-static` chains through
      // `next()` the same way, so two roots on one prefix both get a turn.
      //
      // A *native* root is the mirror image, because that is what Bun's
      // `{ dir }` route does on the hot path: the route map is consulted
      // first (Bun prefers the more specific pattern over `/prefix/*`), the
      // directory answers only what is left, and its miss is a hard 404. So
      // it is carried past dispatch and consumed there instead.
      if (this.staticAssets.length === 0) {
        return this.dispatchRoutes(req, res, pathname);
      }

      const classic: StaticMatch[] = [];
      let native: StaticMatch | null = null;
      for (const match of matchStatic(this.staticAssets, pathname)) {
        if (match.entry.native) {
          if (native === null) native = match;
        } else {
          classic.push(match);
        }
      }

      if (classic.length !== 0 && (req.method === 'GET' || req.method === 'HEAD')) {
        return this.serveStaticChain(classic, 0, req, res, pathname, native);
      }
      this.dispatchRoutes(req, res, pathname, native);
    });
  }

  /** Try each classic mount in registration order; fall through when all miss. */
  private serveStaticChain(
    matches: StaticMatch[],
    idx: number,
    req: BunRequest,
    res: BunResponse,
    pathname: string,
    native: StaticMatch | null,
  ) {
    if (idx >= matches.length) {
      return this.dispatchRoutes(req, res, pathname, native);
    }
    serveStatic(matches[idx], res, req)
      .then(handled => {
        if (handled || res.finished) return;
        this.serveStaticChain(matches, idx + 1, req, res, pathname, native);
      })
      .catch(err => res._reject(err));
  }

  /** Route + middleware dispatch shared by the plain path and the static-miss path. */
  private dispatchRoutes(
    req: BunRequest,
    res: BunResponse,
    pathname: string,
    nativeStatic: StaticMatch | null = null,
  ) {
    const noRoute = () => this.finishNoRoute(req, res, pathname, nativeStatic);

    // Fast path — no global middleware: skip the Promise/await chain.
    if (this.router.middleware.length === 0) {
      const matches = this.router.matchAll(req.method, pathname);
      if (matches.length === 0) {
        return noRoute();
      }
      this.runRouteChain(matches, req, res, () => {
        if (!res.finished) noRoute();
      });
      return;
    }

    // Middleware path — middleware runs FIRST (it may handle the
    // request itself, e.g. Apollo's `app.use('/graphql', expressMiddleware)`
    // owns every `/graphql` request and never matches a Nest route).
    // Only after middleware finishes without writing the response do we
    // dispatch routes / 404.
    this.runGlobalMiddleware(req, res)
      .then(() => {
        if (res.finished) return;
        const matches = this.router.matchAll(req.method, pathname);
        if (matches.length === 0) {
          return noRoute();
        }
        this.runRouteChain(matches, req, res, () => {
          if (!res.finished) noRoute();
        });
      })
      .catch(err => this.dispatchError(err, req, res));
  }

  /**
   * Hand an error to the handler Nest registered via `setErrorHandler()`,
   * falling back to the built-in 500. Shared by route dispatch, middleware and
   * the body-parser rejection so all three render errors the same way.
   */
  private dispatchError(err: unknown, req: BunRequest, res: BunResponse) {
    if (this.errorHandler) {
      try {
        this.errorHandler(err, req, res, () => res._reject(err));
      } catch (e2) {
        res._reject(e2);
      }
      return;
    }
    res._reject(err);
  }

  /**
   * A payload the body parser rejected never reaches a handler. `body-parser`
   * answers 400 for this, so wrap the `SyntaxError` in the exception that
   * renders the same way and let Nest's error handler write it.
   */
  private settleBodyParseError(req: BunRequest, server?: BunServer) {
    return new Promise<Response>(resolve => {
      const res = makeBunResponse(this, req, resolve, server);
      this.dispatchError(new BadRequestException(req.bodyParseError!.message), req, res);
    });
  }

  private async runGlobalMiddleware(req: BunRequest, res: BunResponse) {
    for (const mw of this.router.middleware) {
      if (!matchesPathPrefix(req.path, mw.prefix)) continue;
      if (res.finished) return;
      await new Promise<void>((resolveStep, rejectStep) => {
        try {
          const ret = mw.handler(req, res, (err?: unknown) => {
            if (err) rejectStep(err);
            else resolveStep();
          });
          if (isThenable(ret)) {
            ret.then(() => resolveStep(), rejectStep);
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
    const step = (err?: unknown) => {
      if (err) return this.dispatchError(err, req, res);
      if (res.finished) return;
      if (idx >= matches.length) return onExhausted();
      const { route, params } = matches[idx++];
      req.params = params;
      try {
        const ret = route.handler(req, res, step);
        if (isThenable(ret)) {
          ret.catch(step);
        }
      } catch (e) {
        step(e);
      }
    };
    step();
  }

  /**
   * No route matched. A native static root owns the tail of the request:
   * it serves the file or hard-404s, and Nest's own not-found handler never
   * runs — exactly as on the hot path, where Bun's `{ dir }` route answers
   * without ever reaching `fetch`.
   */
  private finishNoRoute(
    req: BunRequest,
    res: BunResponse,
    pathname: string,
    nativeStatic: StaticMatch | null,
  ) {
    if (!nativeStatic) return this.dispatchNotFound(req, res);
    const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    serveNativeStatic(nativeStatic, req, res, pathname, search).catch(err =>
      res._reject(err),
    );
  }

  private dispatchNotFound(req: BunRequest, res: BunResponse) {
    if (this.notFoundHandler) {
      // The handler gets a real `next` that falls back to the built-in 404.
      // It used to receive a no-op, so a handler that delegated instead of
      // writing left the response promise pending and hung the connection.
      const next = (err?: unknown) => {
        if (err) return res._reject(err);
        if (!res.finished) this.renderDefaultNotFound(res);
      };
      try {
        const ret = this.notFoundHandler(req, res, next);
        if (isThenable(ret)) ret.catch(err => res._reject(err));
      } catch (err) {
        res._reject(err);
      }
      return;
    }
    this.renderDefaultNotFound(res);
  }

  private renderDefaultNotFound(res: BunResponse) {
    res.statusCode = 404;
    res.headers['content-type'] = 'application/json; charset=utf-8';
    res.finished = true;
    res.headersSent = true;
    res._resolve(
      new Response(
        '{"statusCode":404,"message":"Not Found"}',
        toResponseInit(res.headers, 404),
      ),
    );
  }
}
