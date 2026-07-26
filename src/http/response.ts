import { EventEmitter } from 'events';
import { signCookie } from './cookies';
import {
  BunRequest,
  BunResponse,
  BunResponseHeaders,
  CookieOptions,
  ResponseAdapter,
} from './types';

export function toResponseInit(headers: BunResponseHeaders, status: number) {
  // If there are no array values (like set-cookie), we can pass the plain object to avoid allocations.
  let hasArray = false;
  for (const key in headers) {
    if (Array.isArray(headers[key])) {
      hasArray = true;
      break;
    }
  }
  if (!hasArray) {
    return { status, headers: headers as Record<string, string> };
  }

  const initHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const val of value) {
        initHeaders.append(key, val);
      }
    } else {
      initHeaders.set(key, value);
    }
  }
  return { status, headers: initHeaders };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string' && err) return err;
  return 'Internal Server Error';
}

/**
 * Per-response settle state, shared between `makeBunResponse` and the writable
 * shim. `settled` is the single source of truth for "the `Promise<Response>`
 * handed to Bun has been resolved" — the older code inferred it from
 * `finished`/`headersSent`, which the streaming upgrade set inconsistently and
 * which let error paths resolve an already-settled promise (a silent no-op)
 * instead of failing the request. That left the connection open forever.
 */
interface ResponseState {
  settled: boolean;
  streamCtrl: ReadableStreamDefaultController<Uint8Array> | null;
  /**
   * HEAD-request mode: the response settled headers-only and every subsequent
   * write is swallowed. A HEAD response carries no body by definition, so
   * handing Bun a `ReadableStream` nobody drains would queue chunks forever —
   * which is exactly what an `@Sse()` route reached over HEAD did.
   */
  discarded: boolean;
}

export function makeBunResponse(
  adapter: ResponseAdapter,
  req: BunRequest,
  resolve: (r: Response) => void,
): BunResponse {
  const state: ResponseState = { settled: false, streamCtrl: null, discarded: false };
  // Every exit point goes through here, so the response can only settle once.
  const settle = (r: Response) => {
    if (state.settled) return;
    state.settled = true;
    resolve(r);
  };

  const res: BunResponse = {
    statusCode: 200,
    headers: Object.create(null) as BunResponseHeaders,
    body: undefined,
    headersSent: false,
    finished: false,
    get _streaming() {
      return state.streamCtrl !== null;
    },
    _resolve: settle,
    _reject(err: unknown) {
      // Already streaming: the status line and headers are on the wire, so a
      // 500 body is no longer possible. Erroring the stream aborts the chunked
      // response, which is the only way left to tell the client it failed —
      // and, critically, it terminates the request instead of hanging it.
      if (state.streamCtrl) {
        this.finished = true;
        try {
          state.streamCtrl.error(
            err instanceof Error ? err : new Error(errorMessage(err)),
          );
        } catch {}
        state.streamCtrl = null;
        return;
      }
      if (this.finished || state.settled) return;
      this.finished = true;
      this.headersSent = true;
      settle(
        Response.json(
          {
            statusCode: 500,
            message: errorMessage(err),
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
    send(body?: unknown) {
      adapter.reply(this, body);
      return this;
    },
    json(body: unknown) {
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
    set(name: string | Record<string, string | number>, value?: string) {
      if (typeof name === 'object') {
        for (const [k, v] of Object.entries(name)) {
          this.headers[k.toLowerCase()] = String(v);
        }
      } else if (value !== undefined) {
        this.headers[name.toLowerCase()] = String(value);
      }
      return this;
    },
    header(name: string | Record<string, string | number>, value?: string) {
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
    cookie(name: string, value: string | object, options: CookieOptions = {}) {
      let val = typeof value === 'object' ? 'j:' + JSON.stringify(value) : String(value);
      if (options.signed && adapter.cookieSecret) {
        val = signCookie(val, adapter.cookieSecret);
      }

      const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(val)}`];
      if (options.maxAge !== undefined) {
        parts.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
      }
      if (options.domain) parts.push(`Domain=${options.domain}`);
      if (options.path) parts.push(`Path=${options.path}`);
      else parts.push('Path=/');
      if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
      if (options.httpOnly) parts.push('HttpOnly');
      if (options.secure) parts.push('Secure');
      if (options.sameSite) {
        const ss =
          options.sameSite === true ? 'strict' : String(options.sameSite).toLowerCase();
        parts.push(`SameSite=${ss.charAt(0).toUpperCase() + ss.slice(1)}`);
      }

      adapter.appendHeader(this, 'Set-Cookie', parts.join('; '));
      return this;
    },
    clearCookie(name: string, options: CookieOptions = {}) {
      const opts = { ...options, expires: new Date(1), maxAge: 0 };
      return this.cookie(name, '', opts);
    },
  };
  attachWritableShim(res, state, settle);
  return res;
}

type WriteCallback = (err?: Error | null) => void;

/**
 * Node `Writable`-shaped surface grafted onto BunResponse so Nest's
 * `RouterResponseController.sse()` (which pipes a `SseStream` into the
 * response) sees a familiar contract. Express middleware (e.g. Apollo's
 * `expressMiddleware`) also calls `setHeader`/`getHeader` directly.
 */
export interface NodeWritableShim {
  write(
    chunk: unknown,
    encodingOrCb?: string | WriteCallback,
    cb?: WriteCallback,
  ): boolean;
  end(
    chunk?: unknown,
    encodingOrCb?: string | WriteCallback,
    cb?: WriteCallback,
  ): unknown;
  writeHead(
    statusCode: number,
    statusMessageOrHeaders?: string | Record<string, string | number | string[]>,
    maybeHeaders?: Record<string, string | number | string[]>,
  ): unknown;
  flushHeaders(): unknown;
  setHeader(name: string, value: string | string[] | number): unknown;
  getHeader(name: string): string | string[] | undefined;
  removeHeader(name: string): void;
  readonly writableEnded: boolean;
  readonly destroyed: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  emit(event: string, ...args: unknown[]): boolean;
}

function toBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  return new TextEncoder().encode(String(chunk));
}

/**
 * Add the Node `Writable` methods to a BunResponse. Until any of them is
 * actually called, the response stays in the cheap buffered mode; the first
 * `write`/`writeHead`/`flushHeaders` upgrades it to a streaming Response.
 */
function attachWritableShim(
  res: BunResponse,
  state: ResponseState,
  settle: (r: Response) => void,
): void {
  const emitter = new EventEmitter();

  const ensureStreaming = () => {
    if (state.streamCtrl || state.discarded) return;
    // HEAD must not carry a body. Since `HEAD` falls back to the `GET` handler,
    // a streaming route (SSE, StreamableFile) would otherwise hand Bun a stream
    // it never reads — the source keeps producing into a buffer nobody drains
    // and never tears down. Settle headers-only and tell the handler the client
    // is gone so its subscription unwinds.
    if (res.req?.method === 'HEAD') {
      state.discarded = true;
      res.headersSent = true;
      res.finished = true;
      settle(new Response(null, toResponseInit(res.headers, res.statusCode || 200)));
      // Deferred: emitting synchronously would re-enter a handler that is
      // mid-write (Nest's SseStream calls write() then inspects the response).
      queueMicrotask(() => {
        (res.req as unknown as { emit?(event: string): boolean }).emit?.('close');
      });
      return;
    }
    // `start` runs synchronously inside the constructor, so `state.streamCtrl`
    // is populated before we settle — `_reject` can rely on it immediately.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        state.streamCtrl = c;
      },
    });
    res.headersSent = true;
    settle(new Response(stream, toResponseInit(res.headers, res.statusCode || 200)));
  };

  const r = res as BunResponse & NodeWritableShim;
  r.write = (chunk, encodingOrCb, cb) => {
    let callback = cb;
    if (typeof encodingOrCb === 'function') callback = encodingOrCb;
    // `discarded` implies `finished`, so it has to be checked first — a HEAD
    // response is deliberately settled early and keeps accepting writes.
    if (r.finished && !state.discarded) {
      callback?.(new Error('write after end'));
      return false;
    }
    ensureStreaming();
    if (state.discarded) {
      // HEAD: report success so the producer doesn't treat it as a write
      // error, but drop the bytes — the response is headers-only.
      callback?.();
      return true;
    }
    try {
      state.streamCtrl!.enqueue(toBytes(chunk));
    } catch (err) {
      callback?.(err as Error);
      return false;
    }
    callback?.();
    return true;
  };

  r.end = ((
    chunk?: unknown,
    encodingOrCb?: string | WriteCallback,
    cb?: WriteCallback,
  ) => {
    let callback = cb;
    if (typeof chunk === 'function') {
      callback = chunk as WriteCallback;
      chunk = undefined;
    } else if (typeof encodingOrCb === 'function') {
      callback = encodingOrCb;
    }
    if (r.finished) {
      callback?.();
      return r;
    }
    if (state.streamCtrl) {
      // Already in streaming mode — flush remaining chunk + close.
      if (chunk !== undefined) r.write(chunk);
      try {
        state.streamCtrl.close();
      } catch {}
      // Clear it so a later `_reject` doesn't try to error a closed controller
      // and instead takes the "already finished" early return.
      state.streamCtrl = null;
    } else {
      // Non-streaming path: settle a single buffered Response.
      r.finished = true;
      r.headersSent = true;
      settle(
        new Response(
          (chunk as BodyInit | undefined) ?? null,
          toResponseInit(r.headers, r.statusCode || 200),
        ),
      );
    }
    r.finished = true;
    r.headersSent = true;
    emitter.emit('finish');
    emitter.emit('close');
    callback?.();
    return r;
  }) as BunResponse['end'] & NodeWritableShim['end'];

  r.writeHead = (statusCode, statusMessageOrHeaders, maybeHeaders) => {
    r.statusCode = statusCode;
    let headers = maybeHeaders;
    if (typeof statusMessageOrHeaders === 'object' && statusMessageOrHeaders !== null) {
      headers = statusMessageOrHeaders;
    }
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        r.headers[k.toLowerCase()] = Array.isArray(v) ? v : String(v);
      }
    }
    ensureStreaming();
    return r;
  };

  r.flushHeaders = () => {
    ensureStreaming();
    return r;
  };

  r.setHeader = (name, value) => {
    r.headers[String(name).toLowerCase()] = Array.isArray(value) ? value : String(value);
    return r;
  };
  r.getHeader = name => {
    return r.headers[String(name).toLowerCase()];
  };
  r.removeHeader = name => {
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
