import { EventEmitter } from 'events';
import { parseCookies } from './cookies';
import { accepts, acceptsEncodings, acceptsLanguages, typeIs } from './negotiation';
import {
  BunRequest,
  ByteRanges,
  EMPTY_PARAMS,
  EMPTY_QUERY,
  RangeParseResult,
} from './types';

/** Parse a (possibly multi-)`Range` header against `size`, Express-style. */
function parseRangeHeader(header: string | undefined, size: number): RangeParseResult {
  if (!header) return undefined;
  if (!header.startsWith('bytes=')) return -2;
  const ranges = [] as unknown as ByteRanges;
  ranges.type = 'bytes';
  for (const spec of header.slice(6).split(',')) {
    const dash = spec.indexOf('-');
    if (dash === -1) return -2;
    const startStr = spec.slice(0, dash).trim();
    const endStr = spec.slice(dash + 1).trim();
    let start: number;
    let end: number;
    if (startStr === '') {
      const suffix = Number(endStr);
      if (!Number.isFinite(suffix)) return -2;
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(startStr);
      end = endStr === '' ? size - 1 : Number(endStr);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return -2;
      if (end > size - 1) end = size - 1;
    }
    if (start > end || start < 0) continue; // skip unsatisfiable sub-range
    ranges.push({ start, end });
  }
  return ranges.length === 0 ? -1 : ranges;
}

/** Express subdomains (offset 2), e.g. `api.x.example.com` → `['x', 'api']`. */
function computeSubdomains(hostname: string): string[] {
  if (!hostname || /^[\d.]+$/.test(hostname) || hostname.includes(':')) return [];
  const parts = hostname.split('.').reverse();
  return parts.slice(2);
}

/**
 * The Express content-negotiation + connection helpers, bound to a request's
 * headers / hostname. `fresh` / `stale` / `res` are placeholders here and are
 * replaced with live getters in `makeBunResponse` once the response exists.
 */
function reqHelpers(h: Record<string, string>, hostname: string) {
  return {
    accepts: (...types: string[]) => accepts(h['accept'], types),
    acceptsEncodings: (...encs: string[]) => acceptsEncodings(h['accept-encoding'], encs),
    acceptsLanguages: (...langs: string[]) =>
      acceptsLanguages(h['accept-language'], langs),
    is: (...types: string[]) => typeIs(h['content-type'], types),
    range: (size: number) => parseRangeHeader(h['range'], size),
    xhr: (h['x-requested-with'] || '').toLowerCase() === 'xmlhttprequest',
    subdomains: computeSubdomains(hostname),
    fresh: false,
    stale: true,
    res: undefined,
  };
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
  /** Honour `x-forwarded-for` / `x-forwarded-proto` for ip/protocol. */
  trustProxy: boolean;
  /** The server is bound with TLS, so the default protocol is `https`. */
  isSecure: boolean;
}

export interface ConnectionInfo {
  ip: string;
  ips: string[];
  protocol: string;
  secure: boolean;
}

/**
 * Derive Express-style `ip` / `ips` / `protocol` / `secure` from the socket
 * peer address plus (when `trustProxy`) the forwarding headers. Without
 * `trustProxy` the forwarding headers are ignored — the leftmost `x-forwarded-*`
 * is attacker-controlled and must not be trusted by default.
 */
export function resolveConnection(
  headers: Record<string, string>,
  ctx: RequestShimContext,
  socketAddress: string | undefined,
): ConnectionInfo {
  let ip = socketAddress || '127.0.0.1';
  let ips: string[] = [];
  let protocol = ctx.isSecure ? 'https' : 'http';

  if (ctx.trustProxy) {
    const xff = headers['x-forwarded-for'];
    if (xff) {
      ips = xff
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      if (ips.length > 0) ip = ips[0];
    }
    const xfp = headers['x-forwarded-proto'];
    if (xfp) protocol = xfp.split(',', 1)[0].trim();
  }

  return { ip, ips, protocol, secure: protocol === 'https' };
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
 * Convert a Bun.serve route request (already carries `.params`) into the shim
 * our handlers expect. Body parsing stays lazy: `req.body` is filled in by
 * `maybeParseBody()` before handler invocation when the route can have one.
 */
export function buildNativeRouteRequest(
  bunReq: NativeRouteRequest,
  ctx: RequestShimContext,
  socketAddress?: string,
): BunRequest {
  const params = bunReq.params ?? EMPTY_PARAMS;
  const headers = buildHeaders(bunReq.headers);
  const method = bunReq.method;
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
  const hostHeader = headers['host'];
  const hostname = hostHeader ? hostHeader.split(':', 1)[0] : '';

  let bodyResolved: unknown = undefined;
  let bodyConsumed = false;

  const ensureBody = () => {
    if (bodyConsumed) return bodyResolved;
    if (!ctx.bodyParserEnabled || method === 'GET' || method === 'HEAD' || !bunReq.body) {
      bodyConsumed = true;
      return undefined;
    }
    // The canonical `req.body` is filled in before handler invocation via
    // `maybeParseBody()`; this sync getter only covers reads that happen
    // before parsing (returns undefined).
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

  const parsedCookies = parseCookies(headers['cookie'], ctx.cookieSecret);
  const conn = resolveConnection(headers, ctx, socketAddress);
  const req: BunRequest = {
    method,
    url: fullPath,
    originalUrl: fullPath,
    baseUrl: '',
    path: pathname,
    hostname,
    ip: conn.ip,
    ips: conn.ips,
    protocol: conn.protocol,
    secure: conn.secure,
    headers,
    params,
    query,
    cookies: parsedCookies.cookies,
    signedCookies: parsedCookies.signedCookies,
    get body() {
      return ensureBody();
    },
    set body(v: unknown) {
      bodyConsumed = true;
      bodyResolved = v;
    },
    rawBody: undefined,
    // Original Web Request — exposed under a non-`raw` key so it doesn't
    // collide with Nest core's Fastify-style `(req as any).raw || req`
    // fallback used in router-execution-context.ts (SSE / render paths).
    bunRequest: bunReq,
    get(name: string) {
      return headers[name.toLowerCase()];
    },
    header(name: string) {
      return headers[name.toLowerCase()];
    },
    ...reqHelpers(headers, hostname),
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
  socketAddress?: string,
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

  const hostHeader = headers['host'];
  const hostname = hostHeader ? hostHeader.split(':', 1)[0] : '';

  const parsedCookies = parseCookies(headers['cookie'], ctx.cookieSecret);
  const conn = resolveConnection(headers, ctx, socketAddress);
  const req: BunRequest = {
    method,
    url: fullPath,
    originalUrl: fullPath,
    baseUrl: '',
    path: pathname,
    hostname,
    ip: conn.ip,
    ips: conn.ips,
    protocol: conn.protocol,
    secure: conn.secure,
    headers,
    params: EMPTY_PARAMS,
    query,
    body,
    rawBody,
    cookies: parsedCookies.cookies,
    signedCookies: parsedCookies.signedCookies,
    bunRequest: raw,
    get(name: string) {
      return this.headers[name.toLowerCase()];
    },
    header(name: string) {
      return this.headers[name.toLowerCase()];
    },
    ...reqHelpers(headers, hostname),
  };
  return req;
}
