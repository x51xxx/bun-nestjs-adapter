import type { Server } from 'bun';

/** The Bun.serve instance type with our per-socket upgrade payload. */
export type BunServer = Server<WsUpgradeData>;

export interface BunRequest {
  method: string;
  url: string;
  originalUrl: string;
  baseUrl: string;
  path: string;
  hostname: string;
  ip: string;
  /** Forwarded-for chain (left→right) when `trustProxy` is on, else empty. */
  ips: string[];
  /** `'https'` when served over TLS (or `x-forwarded-proto` under trustProxy). */
  protocol: string;
  /** `true` when `protocol === 'https'`. */
  secure: boolean;
  headers: Record<string, string>;
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  /** Parsed request body. Intentionally `any` — its shape is owned by the
   *  application (Nest pipes / DTOs), mirroring Express' `Request['body']`. */
  body: any;
  rawBody?: Buffer;
  cookies?: Record<string, unknown>;
  signedCookies?: Record<string, unknown>;
  /** Reference to the underlying Web `Request` object. */
  bunRequest: Request;
  get(name: string): string | undefined;
  header(name: string): string | undefined;
  /** Best match of `types` against the `Accept` header, or `false`. */
  accepts(...types: string[]): string | false;
  /** Best match against `Accept-Encoding` (defaults to `identity`), or `false`. */
  acceptsEncodings(...encodings: string[]): string | false;
  /** Best match against `Accept-Language`, or `false`. */
  acceptsLanguages(...languages: string[]): string | false;
  /** Does the request body `Content-Type` match? Matched type / `false` / `null`. */
  is(...types: string[]): string | false | null;
  /** Parse the `Range` header against `size`: ranges array, `-1`, `-2`, or `undefined`. */
  range(size: number): RangeParseResult;
  /** `true` when `X-Requested-With: XMLHttpRequest`. */
  xhr: boolean;
  /** Subdomains of the hostname (Express, offset 2), e.g. `api.x.com` → `['api']`. */
  subdomains: string[];
  /** `true` when the response is still fresh per the request's cache validators. */
  fresh: boolean;
  /** Inverse of {@link fresh}. */
  stale: boolean;
  /** Back-reference to the response, wired by `makeBunResponse`. */
  res?: BunResponse;
}

/** A satisfiable byte-range list (carries `type`, like Express' `req.range`). */
export interface ByteRanges extends Array<{ start: number; end: number }> {
  type: string;
}

/** `-1` unsatisfiable, `-2` malformed, `undefined` no header, else the ranges. */
export type RangeParseResult = ByteRanges | -1 | -2 | undefined;

/**
 * Plain-object outbound headers map. Bun.serve accepts `Record<string,string>`
 * for the `Response` headers init, so we skip the cost of constructing a real
 * `Headers` instance per request. Multi-value headers are stored as arrays.
 */
export type BunResponseHeaders = Record<string, string | string[]>;

/** Express-compatible options accepted by `res.sendFile()` / `res.download()`. */
export interface SendFileOptions {
  /** Resolve `path` relative to this root and reject `..` traversal. */
  root?: string;
  /** Override the content-type (otherwise derived from the extension). */
  contentType?: string;
  /** `Cache-Control` value to emit. */
  cacheControl?: string;
  /** Shorthand for `Cache-Control: public, max-age=<maxAge>` (seconds). */
  maxAge?: number;
  /** Extra response headers to set before sending. */
  headers?: Record<string, string>;
}

/** Express-compatible options accepted by `res.cookie()` / `res.clearCookie()`. */
export interface CookieOptions {
  /** Lifetime in milliseconds (Express semantics — emitted as `Max-Age` seconds). */
  maxAge?: number;
  domain?: string;
  path?: string;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  /** Sign the value with the secret passed to `enableCookieParser()`. */
  signed?: boolean;
  sameSite?: boolean | 'lax' | 'strict' | 'none' | string;
}

export interface BunResponse {
  statusCode: number;
  headers: BunResponseHeaders;
  /** Last body value written. Intentionally `any` — mirrors Express. */
  body: any;
  headersSent: boolean;
  finished: boolean;
  _resolve: (response: Response) => void;
  _reject: (err: unknown) => void;
  req: BunRequest;
  status(code: number): BunResponse;
  send(body?: unknown): BunResponse;
  json(body: unknown): BunResponse;
  end(message?: string): BunResponse;
  redirect(urlOrStatus: number | string, maybeUrl?: string): BunResponse;
  set(name: string | Record<string, string | number>, value?: string): BunResponse;
  header(name: string | Record<string, string | number>, value?: string): BunResponse;
  get(name: string): string | undefined;
  type(contentType: string): BunResponse;
  cookie(name: string, value: string | object, options?: CookieOptions): BunResponse;
  clearCookie(name: string, options?: CookieOptions): BunResponse;
  sendFile(path: string, options?: SendFileOptions, cb?: (err?: unknown) => void): void;
  download(
    path: string,
    filename?: string,
    options?: SendFileOptions,
    cb?: (err?: unknown) => void,
  ): void;
  /** Content-negotiated dispatch: pick the handler matching the `Accept` header. */
  format(handlers: Record<string, () => void>): BunResponse;
  /** JSON with optional JSONP callback wrapping when `?callback=` is present. */
  jsonp(body: unknown): BunResponse;
  /** Set `Content-Disposition: attachment` (and a type from the extension). */
  attachment(filename?: string): BunResponse;
  /** Set the `Location` response header. */
  location(url: string): BunResponse;
  /** Append a field to the `Vary` response header. */
  vary(field: string | string[]): BunResponse;
  /** Append a value to a (possibly multi-valued) response header. */
  append(name: string, value: string | string[]): BunResponse;
  /** Set the status code and send its standard reason phrase as the body. */
  sendStatus(code: number): BunResponse;
  /** Set the `Link` response header from a `{ rel: url }` map. */
  links(links: Record<string, string>): BunResponse;
}

export type BunRouteHandler = (
  req: BunRequest,
  res: BunResponse,
  next?: (err?: unknown) => void,
) => unknown;

export type BunErrorHandler = (
  err: unknown,
  req: BunRequest,
  res: BunResponse,
  next: (err?: unknown) => void,
) => unknown;

/**
 * The subset of BunHttpAdapter that response shims need. Kept as a structural
 * interface so `http/` modules never import the adapter class (which would
 * create a cycle adapters → http → adapters).
 */
export interface ResponseAdapter {
  cookieSecret: string | null;
  reply(response: BunResponse, body: unknown, statusCode?: number): void;
  end(response: BunResponse, message?: string): void;
  redirect(response: BunResponse, statusCode: number, url: string): void;
  appendHeader(response: BunResponse, name: string, value: string): void;
  sendFile(
    response: BunResponse,
    path: string,
    options?: SendFileOptions,
    cb?: (err?: unknown) => void,
  ): void;
}

/**
 * Structural view of BunWsClient / BunWsServer from bun-ws-adapter.ts. The
 * HTTP side must not import that module (it pulls the optional
 * `@nestjs/websockets` peer dependency), so the shared-port upgrade path is
 * typed against these shapes instead.
 */
export interface WsClientShim {
  bunWs: unknown;
  pattern?: string;
  __markOpen(): void;
  __onMessage(data: string | Buffer): void;
  __onClose(code?: number, reason?: string): void;
}

export interface WsServerShim {
  path: string;
  bunServer: BunServer | null;
  clients: Set<WsClientShim>;
  clientClass: new (ws: null) => WsClientShim;
  emit(event: string, ...args: unknown[]): boolean;
}

/** Per-socket payload attached at `server.upgrade(req, { data })` time. */
export interface WsUpgradeData {
  client: WsClientShim;
  server: WsServerShim;
}

/**
 * Tuning knobs forwarded verbatim to the `websocket` block of `Bun.serve`.
 * Defined here (HTTP types, no `@nestjs/websockets` import) so the shared-port
 * HTTP server can apply them without importing the WS adapter module.
 */
export interface BunWsServeOptions {
  /** Max inbound message size in bytes (default 16 MB). */
  maxPayloadLength?: number;
  /** Bytes buffered before a socket is considered backpressured. */
  backpressureLimit?: number;
  /** Close the connection when `backpressureLimit` is exceeded. */
  closeOnBackpressureLimit?: boolean;
  /** Idle timeout in seconds before an inactive socket is closed. */
  idleTimeout?: number;
  /** Deliver a published message back to the publishing socket too. */
  publishToSelf?: boolean;
  /** Automatically send pings to keep connections alive. */
  sendPings?: boolean;
  /** Per-message-deflate compression level (`false`/`true`/preset string). */
  perMessageDeflate?: boolean | string | { compress?: unknown; decompress?: unknown };
}

// Pre-allocated frozen empty maps — reused across requests that don't have
// query or path params, to skip per-request object allocations.
export const EMPTY_QUERY: Record<string, string | string[]> = Object.freeze(
  Object.create(null),
);
export const EMPTY_PARAMS: Record<string, string> = Object.freeze(Object.create(null));
