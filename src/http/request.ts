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

/**
 * `req.socket` stand-in. There is no Node socket under Bun, but two bits of
 * Nest core reach for one: `SseStream.commitHeaders()` pokes
 * `setKeepAlive`/`setNoDelay`, and since Nest 12
 * `RouterResponseController.sse()` picks `request.socket ?? response` as its
 * disconnect source and subscribes with `.once('close', …)`. So the socket has
 * to share the request's emitter rather than be a frozen no-op singleton.
 */
export function makeNoopSocket(emitter: EventEmitter) {
  return {
    setKeepAlive: () => {},
    setNoDelay: () => {},
    setTimeout: () => {},
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
    removeListener: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
  };
}

/**
 * Strip the port from a `Host` header. An IPv6 literal is bracketed
 * (`[::1]:3000`), so splitting on the first `:` returned `'['`; Express keeps
 * the brackets and returns `[::1]`.
 */
function hostnameOf(host: string): string {
  if (host.charCodeAt(0) === 0x5b) {
    // 0x5b = '['
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.indexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

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
  /**
   * The `SyntaxError` a malformed JSON payload produced. Reported rather than
   * swallowed: `body-parser` answers 400 for this, and silently handing the
   * handler `undefined` turned a bad payload into a confusing DTO-validation
   * failure further down (or, on a route with no validation, into nothing at
   * all). The dispatcher maps it to the same `BadRequestException`
   * platform-express ends up with.
   */
  error?: Error;
}

const NO_BODY: ParsedBody = Object.freeze({ body: undefined });

function asSyntaxError(err: unknown): Error {
  return err instanceof Error ? err : new SyntaxError(String(err));
}

/** `body-parser`'s default `type: 'application/json'`, charset params included. */
function isJsonContentType(contentType: string): boolean {
  return contentType.includes('application/json');
}

/**
 * `body-parser` runs with `strict: true` by default: only an object or an array
 * is a valid top-level JSON body, so `null`, `123`, `true` and `"str"` are 400s
 * even though they parse. It decides on the payload's first non-whitespace
 * character; deciding on the parsed *value* instead accepts and rejects exactly
 * the same set, and works on the fast path where we never materialise the text.
 */
function violatesStrictJson(value: unknown): boolean {
  return typeof value !== 'object' || value === null;
}

function strictJsonError(): Error {
  return new SyntaxError('Expected an object or array at the top level of the JSON body');
}

/**
 * An empty payload on a JSON route is `{}`, not "no body" — `body-parser`
 * special-cases it because sending one is such a common client-side mistake.
 * Freshly built every time: a handler may write to `req.body`.
 */
function emptyJsonBody(): ParsedBody {
  return { body: {} };
}

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
  contentLength?: string,
): Promise<ParsedBody> {
  const isJson = isJsonContentType(contentType);
  // The fast path skips the Buffer and the JS string entirely, but it also
  // can't tell an empty payload from a malformed one once the stream is
  // consumed — and those two have different answers (`{}` vs 400). A declared,
  // non-zero `Content-Length` rules the empty case out; without one (a chunked
  // upload) we take the buffered path, which sees the bytes and can.
  if (!rawBodyEnabled && isJson && contentLength !== undefined && contentLength !== '0') {
    try {
      const body = await raw.json();
      if (violatesStrictJson(body)) {
        return { body: undefined, error: strictJsonError() };
      }
      return { body };
    } catch (err) {
      return { body: undefined, error: asSyntaxError(err) };
    }
  }
  const buf = Buffer.from(await raw.arrayBuffer());
  if (buf.length === 0) {
    // An empty-but-present body must still materialise `rawBody` in rawBody
    // mode — signature/webhook verification expects an empty Buffer over a
    // missing one.
    const empty = isJson ? emptyJsonBody() : NO_BODY;
    return rawBodyEnabled ? { body: empty.body, rawBody: buf } : empty;
  }
  if (isJson) {
    try {
      const body = JSON.parse(buf.toString('utf8'));
      if (violatesStrictJson(body)) {
        return { body: undefined, rawBody: buf, error: strictJsonError() };
      }
      return { body, rawBody: buf };
    } catch (err) {
      // `rawBody` still goes through — a webhook verifier wants the bytes even
      // when they don't parse.
      return { body: undefined, rawBody: buf, error: asSyntaxError(err) };
    }
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    // `parseQuery` rather than `Object.fromEntries`: the latter keeps only the
    // last value, so `a=1&a=2` collapsed to `'2'` in the body while the query
    // string parser — right here in this file — correctly produced `['1','2']`.
    // Express (via qs) gives the array; the two parsers now agree.
    return { body: parseQuery(buf.toString('utf8')), rawBody: buf };
  }
  if (contentType.startsWith('text/')) {
    return { body: buf.toString('utf8'), rawBody: buf };
  }
  return { body: buf, rawBody: buf };
}

/**
 * Decide whether this request has a body worth parsing, and parse it. The one
 * gate both dispatch paths go through — they used to carry their own copies of
 * these conditions, which is precisely how the request shims drifted apart in
 * the first place (see H3 in AUDIT.md).
 *
 * Skipped for GET/HEAD, for multipart (left for interceptors to read via
 * `req.bunRequest.formData()`), and for an empty non-JSON payload. An empty
 * *JSON* payload is not skipped: it resolves to `{}`.
 */
export async function resolveRequestBody(
  raw: Request,
  method: string,
  headers: Record<string, string>,
  ctx: RequestShimContext,
): Promise<ParsedBody> {
  if (!ctx.bodyParserEnabled) return NO_BODY;
  if (method === 'GET' || method === 'HEAD') return NO_BODY;
  const ctype = headers['content-type'] ?? '';
  if (ctype.startsWith('multipart/')) return NO_BODY;
  const isJson = isJsonContentType(ctype);
  const len = headers['content-length'];
  // No body at all — but a JSON route still gets `{}`, the way body-parser
  // hands one back for a request that declared the type and sent nothing.
  if (!raw.body) return isJson ? emptyJsonBody() : NO_BODY;
  if (!ctx.rawBodyEnabled && !isJson && len === '0') return NO_BODY;
  return parseRequestBody(raw, ctype, ctx.rawBodyEnabled, len);
}

/**
 * Parse the body into `req.body` / `req.rawBody` / `req.bodyParseError`.
 * Mutates in place — Nest's route-params factory reads the fields
 * synchronously after this resolves.
 */
export async function maybeParseBody(
  req: BunRequest,
  raw: Request,
  ctx: RequestShimContext,
): Promise<void> {
  const parsed = await resolveRequestBody(raw, req.method, req.headers, ctx);
  if (parsed.body !== undefined) req.body = parsed.body;
  if (parsed.rawBody !== undefined) req.rawBody = parsed.rawBody;
  if (parsed.error !== undefined) req.bodyParseError = parsed.error;
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
  const hostname = hostHeader ? hostnameOf(hostHeader) : '';
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
    // SseStream's commitHeaders touches `req.socket.setKeepAlive/setNoDelay`,
    // and Nest 12's sse() listens for 'close' on it — see makeNoopSocket().
    socket: makeNoopSocket(reqEmitter),
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

  // Same gate as the native-routes hot path — one function, so the two
  // dispatchers cannot disagree about what counts as a body.
  const parsed = await resolveRequestBody(raw, method, headers, ctx);
  const body = parsed.body;
  const rawBody = parsed.rawBody;
  const bodyParseError = parsed.error;

  const req = createRequestShim(
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
  if (bodyParseError !== undefined) req.bodyParseError = bodyParseError;
  return req;
}
