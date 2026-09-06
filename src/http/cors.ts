import { Logger } from '@nestjs/common';
import { BunRequest, BunResponse } from './types';

/** Every non-function shape `origin` accepts, in options or from a callback. */
export type CorsStaticOrigin = string | boolean | RegExp | Array<string | RegExp>;

/** The `cors` package's node-style callback: `callback(null, true)`. */
export type CorsOriginCallback = (err: Error | null, origin?: CorsStaticOrigin) => void;

/**
 * CORS options accepted by `BunHttpAdapter.enableCors()`. Semantics match
 * @nestjs/platform-express + the `cors` package.
 *
 * `origin` accepts **two** function shapes, told apart by arity:
 *
 *   * `(requestOrigin, callback) => void` — the `cors` package contract, which
 *     is what Nest's own documentation shows. Must invoke `callback`
 *     *synchronously*; an async lookup can't be awaited here (the header has to
 *     be on the response before dispatch) and is warned about, not silently
 *     dropped.
 *   * `(req) => origin` — this adapter's original one-argument form, handed the
 *     whole request shim and returning the value directly.
 *
 * TypeScript cannot pick a contextual signature out of a union of function
 * types with different arities, so the one-argument form needs its parameter
 * annotated — `origin: (req: BunRequest) => …` — under `noImplicitAny`. The
 * two-argument form infers normally (its arity rules the other signature out).
 */
export interface CorsOptions {
  origin?:
    | CorsStaticOrigin
    | ((requestOrigin: string, callback: CorsOriginCallback) => void)
    | ((req: BunRequest) => CorsStaticOrigin | null | undefined);
  methods?: string | string[];
  credentials?: boolean;
  allowedHeaders?: string | string[];
  exposedHeaders?: string | string[];
  maxAge?: number;
}

const logger = new Logger('BunHttpAdapter');
/** Warn once per process — this is a config mistake, not a per-request event. */
let warnedAsyncOrigin = false;

/**
 * Reduce any static `origin` value to the header to emit, or `undefined` to
 * emit none. Shared by the plain-option path and both function shapes, so a
 * callback that answers `[/\.example\.com$/]` behaves exactly like the same
 * value passed inline.
 *
 *   * `true`             → echo the request's Origin (or `*` when absent)
 *   * `'*'`              → `*`, unless `credentials` is on — browsers reject
 *                          `*` with credentials, so echo the Origin instead
 *   * `string`           → verbatim
 *   * `RegExp` / array   → echo the request's Origin when it matches
 *   * `false` / nullish  → no header
 */
function resolveStaticOrigin(
  value: CorsStaticOrigin | null | undefined,
  reqOrigin: string | undefined,
  credentials: boolean,
): string | undefined {
  if (value === true) return reqOrigin ?? '*';
  if (value === false || value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const wantsEcho = credentials && value === '*';
    return wantsEcho ? (reqOrigin ?? '*') : value;
  }
  if (value instanceof RegExp) {
    return reqOrigin && value.test(reqOrigin) ? reqOrigin : undefined;
  }
  if (Array.isArray(value)) {
    if (!reqOrigin) return undefined;
    return value.some(o => (o instanceof RegExp ? o.test(reqOrigin) : o === reqOrigin))
      ? reqOrigin
      : undefined;
  }
  return undefined;
}

export function applyCorsHeaders(
  req: BunRequest,
  res: BunResponse,
  options: CorsOptions | true,
): void {
  const opts: CorsOptions = options === true ? {} : options;
  const h = res.headers;
  const reqOrigin = req.headers['origin'];

  const rawOrigin = opts.origin ?? '*';
  const credentials = !!opts.credentials;

  let originHeader: string | undefined;
  if (typeof rawOrigin === 'function') {
    // Arity tells the two contracts apart. A `cors`-style function declares
    // `(requestOrigin, callback)`; ours declares `(req)`. Getting this wrong
    // used to mean the `cors` shape — the one Nest's docs show — was called
    // with the request object and returned `undefined`, so no
    // `Access-Control-Allow-Origin` was emitted at all and CORS was silently
    // off while every *other* CORS header still went out.
    if (rawOrigin.length >= 2) {
      const fn = rawOrigin as (origin: string, cb: CorsOriginCallback) => void;
      let called = false;
      try {
        // `cors` hands the raw header through, which is `undefined` when the
        // request carries no Origin; mirror that rather than inventing ''.
        fn(reqOrigin as string, (err, allow) => {
          called = true;
          if (err) return;
          originHeader = resolveStaticOrigin(allow, reqOrigin, credentials);
        });
      } catch {
        // swallow — caller's CORS function shouldn't break the response.
      }
      if (!called && !warnedAsyncOrigin) {
        warnedAsyncOrigin = true;
        logger.warn(
          'enableCors({ origin }) did not invoke its callback synchronously. ' +
            'Async origin resolution is not supported — the ' +
            'Access-Control-Allow-Origin header is omitted for such requests.',
        );
      }
    } else {
      const fn = rawOrigin as (req: BunRequest) => CorsStaticOrigin | null | undefined;
      try {
        originHeader = resolveStaticOrigin(fn(req), reqOrigin, credentials);
      } catch {
        // swallow — caller's CORS function shouldn't break the response.
      }
    }
  } else {
    originHeader = resolveStaticOrigin(rawOrigin, reqOrigin, credentials);
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
