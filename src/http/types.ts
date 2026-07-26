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
}

/**
 * Plain-object outbound headers map. Bun.serve accepts `Record<string,string>`
 * for the `Response` headers init, so we skip the cost of constructing a real
 * `Headers` instance per request. Multi-value headers are stored as arrays.
 */
export type BunResponseHeaders = Record<string, string | string[]>;

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
  /**
   * True once `write()`/`writeHead()`/`flushHeaders()` upgraded the response to
   * a streaming `ReadableStream`. Past that point the headers are already on
   * the wire, so `reply()`/`end()` must append to the stream rather than try to
   * settle a second buffered `Response`.
   *
   * Optional so that externally-constructed `BunResponse` objects (test doubles,
   * alternate response factories) keep compiling — absent is read as `false`.
   */
  readonly _streaming?: boolean;
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

// Pre-allocated frozen empty maps — reused across requests that don't have
// query or path params, to skip per-request object allocations.
export const EMPTY_QUERY: Record<string, string | string[]> = Object.freeze(
  Object.create(null),
);
export const EMPTY_PARAMS: Record<string, string> = Object.freeze(Object.create(null));
