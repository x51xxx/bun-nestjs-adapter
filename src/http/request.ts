import { EventEmitter } from 'events';
import { parseCookies } from './cookies';
import { BunRequest, EMPTY_PARAMS, EMPTY_QUERY } from './types';

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
export function buildHeaders(rawHeaders: Headers): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  rawHeaders.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export function parseQuery(search: string): Record<string, string | string[]> {
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

// SseStream pokes these on `req.socket`; nothing to do under Bun.
export const NOOP_SOCKET = Object.freeze({
  setKeepAlive: () => {},
  setNoDelay: () => {},
  setTimeout: () => {},
});

/** Adapter state the request builders need — passed by value, no class coupling. */
export interface RequestShimContext {
  bodyParserEnabled: boolean;
  rawBodyEnabled: boolean;
  cookieSecret: string | null;
  /**
   * When true, `req.ip` prefers the left-most `X-Forwarded-For` entry over the
   * real peer address. Off by default: the header is client-controlled, so
   * trusting it unconditionally lets anyone forge the key that rate limiters
   * and audit logs are built on. Enable via `setTrustProxy(true)` when the app
   * genuinely sits behind a proxy that rewrites the header.
   */
  trustProxy: boolean;
}

/** Bun's peer-address lookup, available on both dispatch paths. */
export interface RequestIpSource {
  requestIP(req: Request): { address: string } | null;
}

/**
 * Resolve the client IP lazily — `server.requestIP()` is a native call we don't
 * want on the hot path for the (many) handlers that never read `req.ip`.
 *
 * IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is unwrapped so the value matches what
 * the Express adapter reports.
 */
function makeIpGetter(
  raw: Request,
  headers: Record<string, string>,
  ctx: RequestShimContext,
  server: RequestIpSource | undefined,
): () => string {
  let cached: string | undefined;
  return () => {
    if (cached !== undefined) return cached;
    if (ctx.trustProxy) {
      const forwarded = headers['x-forwarded-for'];
      if (forwarded) {
        const first = forwarded.split(',', 1)[0].trim();
        if (first) return (cached = first);
      }
    }
    const address = server?.requestIP(raw)?.address;
    cached = address ? address.replace(/^::ffff:/, '') : '127.0.0.1';
    return cached;
  };
}

export interface ParsedBody {
  body: unknown;
  rawBody?: Buffer;
}

const NO_BODY: ParsedBody = Object.freeze({ body: undefined });

interface BodySource {
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Consume and parse a request body according to content-type. Shared by the
 * manual `fetch` dispatcher and the native-routes hot path so both behave
 * identically. Multipart is never consumed here — interceptors (e.g.
 * BunFileInterceptor) read `formData()` off the original Web Request.
 *
 * JSON fast path: hand the bytes straight to Bun's native JSON parser
 * (no Buffer materialisation, no JS string allocation). Skipped when the app
 * opts into `rawBody` — we'd need the raw bytes either way.
 */
export async function parseRequestBody(
  raw: BodySource,
  contentType: string,
  rawBodyEnabled: boolean,
): Promise<ParsedBody> {
  if (!rawBodyEnabled && contentType.includes('application/json')) {
    try {
      return { body: await raw.json() };
    } catch {
      return NO_BODY;
    }
  }
  const buf = Buffer.from(await raw.arrayBuffer());
  if (buf.length === 0) {
    // An empty-but-present body must still materialise `rawBody` in rawBody
    // mode — signature/webhook verification expects an empty Buffer over a
    // missing one.
    return rawBodyEnabled ? { body: undefined, rawBody: buf } : NO_BODY;
  }
  if (contentType.includes('application/json')) {
    try {
      return { body: JSON.parse(buf.toString('utf8')), rawBody: buf };
    } catch {
      return { body: undefined, rawBody: buf };
    }
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return {
      body: Object.fromEntries(new URLSearchParams(buf.toString('utf8'))),
      rawBody: buf,
    };
  }
  if (contentType.startsWith('text/')) {
    return { body: buf.toString('utf8'), rawBody: buf };
  }
  return { body: buf, rawBody: buf };
}

/**
 * Parse the body into `req.body` / `req.rawBody` when relevant. Skipped for
 * GET/HEAD, empty payloads (content-length: 0, unless rawBody is enabled) and
 * multipart (left for interceptors to read via `req.bunRequest.formData()`).
 * Mutates in place —
 * Nest's route-params factory reads the fields synchronously after this
 * resolves.
 */
export async function maybeParseBody(
  req: BunRequest,
  raw: Request,
  ctx: RequestShimContext,
): Promise<void> {
  if (!ctx.bodyParserEnabled) return;
  const m = req.method;
  if (m === 'GET' || m === 'HEAD') return;
  if (!raw.body) return;
  if (!ctx.rawBodyEnabled && req.headers['content-length'] === '0') return;
  const ctype = req.headers['content-type'] ?? '';
  if (ctype.startsWith('multipart/')) return;
  const parsed = await parseRequestBody(raw, ctype, ctx.rawBodyEnabled);
  if (parsed.body !== undefined) req.body = parsed.body;
  if (parsed.rawBody !== undefined) req.rawBody = parsed.rawBody;
}

/** Bun's native-route request: a Web `Request` with `params` filled by the matcher. */
export interface NativeRouteRequest extends Request {
  params?: Record<string, string>;
}

/**
 * The one place a `BunRequest` is constructed. Both dispatch paths funnel
 * through it so the shim can't drift again: the native-routes fast path and
 * the manual `fetch` dispatcher differ only in where `params` comes from and
 * in *when* the body is parsed — never in which Node-isms are present.
 *
 * (Before this was unified, only the fast path grafted on the EventEmitter and
 * `socket`, so `RouterResponseController.sse()` — which calls
 * `request.on('close', …)` unconditionally — 500'd on every app that had any
 * middleware, static mount or CORS registered.)
 */
function createRequestShim(
  raw: Request,
  method: string,
  pathname: string,
  fullPath: string,
  headers: Record<string, string>,
  query: Record<string, string | string[]>,
  params: Record<string, string>,
  body: unknown,
  rawBody: Buffer | undefined,
  ctx: RequestShimContext,
  server: RequestIpSource | undefined,
): BunRequest {
  const hostHeader = headers['host'];
  const hostname = hostHeader ? hostHeader.split(':', 1)[0] : '';
  const parsedCookies = parseCookies(headers['cookie'], ctx.cookieSecret);
  const ipGetter = makeIpGetter(raw, headers, ctx, server);

  const reqEmitter = new EventEmitter();
  // Bridge Bun's AbortSignal → Node-style 'close' event so that
  // RouterResponseController.sse() can subscribe via `req.on('close', …)`.
  if (raw.signal && !raw.signal.aborted) {
    raw.signal.addEventListener('abort', () => reqEmitter.emit('close'), {
      once: true,
    });
  }

  const req: BunRequest = {
    method,
    url: fullPath,
    originalUrl: fullPath,
    baseUrl: '',
    path: pathname,
    hostname,
    get ip() {
      return ipGetter();
    },
    headers,
    params,
    query,
    body,
    rawBody,
    cookies: parsedCookies.cookies,
    signedCookies: parsedCookies.signedCookies,
    // Original Web Request — exposed under a non-`raw` key so it doesn't
    // collide with Nest core's Fastify-style `(req as any).raw || req`
    // fallback used in router-execution-context.ts (SSE / render paths).
    bunRequest: raw,
    get(name: string) {
      return headers[name.toLowerCase()];
    },
    header(name: string) {
      return headers[name.toLowerCase()];
    },
  };
  // Extra Node-isms Nest core touches outside the BunRequest contract.
  Object.assign(req, {
    on: reqEmitter.on.bind(reqEmitter),
    once: reqEmitter.once.bind(reqEmitter),
    off: reqEmitter.off.bind(reqEmitter),
    removeListener: reqEmitter.off.bind(reqEmitter),
    emit: reqEmitter.emit.bind(reqEmitter),
    // SseStream's commitHeaders touches `req.socket.setKeepAlive/setNoDelay`
    // — provide a no-op socket so it doesn't crash.
    socket: NOOP_SOCKET,
  });
  return req;
}

/**
 * Convert a Bun.serve route request (already carries `.params`) into the shim
 * our handlers expect. Body parsing stays lazy: `req.body` is filled in by
 * `maybeParseBody()` before handler invocation when the route can have one.
 */
export function buildNativeRouteRequest(
  bunReq: NativeRouteRequest,
  ctx: RequestShimContext,
  server?: RequestIpSource,
): BunRequest {
  const headers = buildHeaders(bunReq.headers);
  const url = bunReq.url;
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

  return createRequestShim(
    bunReq,
    bunReq.method,
    pathname,
    fullPath,
    headers,
    query,
    bunReq.params ?? EMPTY_PARAMS,
    undefined,
    undefined,
    ctx,
    server,
  );
}

/**
 * Build the request shim for the manual `fetch` dispatcher. `pathname`,
 * `fullPath` and `queryStart` are pre-computed by the caller's cheap URL
 * split so the raw URL is only scanned once.
 */
export async function buildFetchRequest(
  raw: Request,
  pathname: string,
  fullPath: string,
  rawUrl: string,
  queryStart: number,
  ctx: RequestShimContext,
  server?: RequestIpSource,
): Promise<BunRequest> {
  const method = raw.method;
  const headers = buildHeaders(raw.headers);

  const query =
    queryStart === -1 ? EMPTY_QUERY : parseQuery(rawUrl.slice(queryStart + 1));

  let body: unknown = undefined;
  let rawBody: Buffer | undefined;
  const ctype = headers['content-type'] ?? '';
  // Skip multipart consumption — BunFileInterceptor will read formData()
  // off the original Web Request itself. Mirrors maybeParseBody() in the
  // routes hot path so behaviour is identical regardless of dispatcher.
  if (
    ctx.bodyParserEnabled &&
    method !== 'GET' &&
    method !== 'HEAD' &&
    raw.body &&
    !ctype.startsWith('multipart/')
  ) {
    const parsed = await parseRequestBody(raw, ctype, ctx.rawBodyEnabled);
    body = parsed.body;
    rawBody = parsed.rawBody;
  }

  return createRequestShim(
    raw,
    method,
    pathname,
    fullPath,
    headers,
    query,
    EMPTY_PARAMS,
    body,
    rawBody,
    ctx,
    server,
  );
}
