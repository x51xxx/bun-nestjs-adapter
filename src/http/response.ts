import { EventEmitter } from 'events';
import { STATUS_CODES } from 'node:http';
import { signCookie } from './cookies';
import {
  BunRequest,
  BunResponse,
  BunResponseHeaders,
  CookieOptions,
  ResponseAdapter,
  SendFileOptions,
} from './types';

// Minimal extension→type map for `res.attachment()` (kept local to avoid a
// circular import with static.ts, which imports `toResponseInit` from here).
const ATTACHMENT_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.zip': 'application/zip',
};

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

/** Weak `If-None-Match` membership (the `W/` prefix is ignored, per RFC 9110). */
function etagInList(header: string, etag: string): boolean {
  const bare = etag.startsWith('W/') ? etag.slice(2) : etag;
  return header.split(',').some(part => {
    const tag = part.trim();
    return (tag.startsWith('W/') ? tag.slice(2) : tag) === bare;
  });
}

/**
 * RFC 9110 freshness — mirrors the `fresh` npm module. Fresh when a cache
 * validator (`If-None-Match` / `If-Modified-Since`) still matches the response.
 */
function computeFresh(req: BunRequest, res: BunResponse): boolean {
  const method = req.method;
  if (method !== 'GET' && method !== 'HEAD') return false;
  const status = res.statusCode;
  if (!((status >= 200 && status < 300) || status === 304)) return false;

  const inm = req.headers['if-none-match'];
  const ims = req.headers['if-modified-since'];
  if (!inm && !ims) return false;

  if (inm && inm !== '*') {
    const etag = res.headers['etag'];
    if (!etag || !etagInList(inm, Array.isArray(etag) ? etag[0] : etag)) return false;
  }
  if (ims) {
    const lm = res.headers['last-modified'];
    const lastModified = Array.isArray(lm) ? lm[0] : lm;
    if (!lastModified || Date.parse(lastModified) > Date.parse(ims)) return false;
  }
  return true;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string' && err) return err;
  return 'Internal Server Error';
}

export function makeBunResponse(
  adapter: ResponseAdapter,
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
    _reject(err: unknown) {
      if (this.finished) return;
      this.finished = true;
      this.headersSent = true;
      resolve(
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
    sendFile(path: string, options?: SendFileOptions, cb?: (err?: unknown) => void) {
      adapter.sendFile(this, path, options, cb);
    },
    format(handlers: Record<string, () => void>) {
      const offered = Object.keys(handlers).filter(k => k !== 'default');
      const chosen = this.req.accepts(...offered);
      if (chosen && handlers[chosen]) {
        this.vary('Accept');
        handlers[chosen]();
      } else if (handlers.default) {
        handlers.default();
      } else {
        this.status(406);
        adapter.reply(this, { statusCode: 406, message: 'Not Acceptable' });
      }
      return this;
    },
    jsonp(body: unknown) {
      const cbName = this.req.query?.callback;
      if (typeof cbName === 'string' && cbName) {
        // Sanitize to a safe JS identifier path before interpolating.
        const safe = cbName.replace(/[^\w$.]/g, '');
        const json = JSON.stringify(body ?? null)
          .replace(/\u2028/g, '\\u2028')
          .replace(/\u2029/g, '\\u2029');
        this.headers['content-type'] = 'application/javascript; charset=utf-8';
        this.headers['x-content-type-options'] = 'nosniff';
        adapter.reply(this, `/**/ typeof ${safe} === 'function' && ${safe}(${json});`);
      } else {
        this.json(body);
      }
      return this;
    },
    attachment(filename?: string) {
      if (filename) {
        const safe = filename.replace(/"/g, '\\"');
        this.headers['content-disposition'] = `attachment; filename="${safe}"`;
        const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
        const mime = ATTACHMENT_MIME[ext];
        if (mime && this.headers['content-type'] === undefined) {
          this.headers['content-type'] = mime;
        }
      } else {
        this.headers['content-disposition'] = 'attachment';
      }
      return this;
    },
    location(url: string) {
      this.headers['location'] = url;
      return this;
    },
    vary(field: string | string[]) {
      const fields = Array.isArray(field) ? field : [field];
      const existing = this.headers['vary'];
      const current =
        existing === undefined
          ? ''
          : Array.isArray(existing)
            ? existing.join(', ')
            : existing;
      const have = new Set(
        current
          .split(',')
          .map(s => s.trim().toLowerCase())
          .filter(Boolean),
      );
      const merged = current ? [current] : [];
      for (const f of fields) {
        if (f === '*') {
          this.headers['vary'] = '*';
          return this;
        }
        if (!have.has(f.toLowerCase())) merged.push(f);
      }
      this.headers['vary'] = merged.join(', ');
      return this;
    },
    append(name: string, value: string | string[]) {
      const values = Array.isArray(value) ? value.map(String) : [String(value)];
      for (const v of values) adapter.appendHeader(this, name, v);
      return this;
    },
    sendStatus(code: number) {
      this.statusCode = code;
      this.headers['content-type'] = 'text/plain; charset=utf-8';
      adapter.reply(this, STATUS_CODES[code] || String(code));
      return this;
    },
    links(links: Record<string, string>) {
      const value = Object.entries(links)
        .map(([rel, url]) => `<${url}>; rel="${rel}"`)
        .join(', ');
      const existing = this.headers['link'];
      this.headers['link'] = existing ? `${existing}, ${value}` : value;
      return this;
    },
    download(
      path: string,
      filename?: string,
      options?: SendFileOptions,
      cb?: (err?: unknown) => void,
    ) {
      // Express semantics: default the download filename to the basename and
      // emit a Content-Disposition: attachment header before sending.
      const name = filename || path.split(/[\\/]/).pop() || 'download';
      this.headers['content-disposition'] =
        `attachment; filename="${name.replace(/"/g, '\\"')}"`;
      adapter.sendFile(this, path, options, cb);
    },
  };
  // Wire the back-reference and live freshness getters now that `res` exists
  // (request builders seed `fresh`/`stale` with placeholders).
  req.res = res;
  Object.defineProperty(req, 'fresh', {
    configurable: true,
    enumerable: true,
    get: () => computeFresh(req, res),
  });
  Object.defineProperty(req, 'stale', {
    configurable: true,
    enumerable: true,
    get: () => !computeFresh(req, res),
  });
  attachWritableShim(res, resolve);
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

  const r = res as BunResponse & NodeWritableShim;
  r.write = (chunk, encodingOrCb, cb) => {
    let callback = cb;
    if (typeof encodingOrCb === 'function') callback = encodingOrCb;
    if (r.finished) {
      callback?.(new Error('write after end'));
      return false;
    }
    ensureStreaming();
    try {
      streamCtrl!.enqueue(toBytes(chunk));
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
