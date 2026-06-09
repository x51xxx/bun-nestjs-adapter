import { BunRequest, BunResponse } from './types';

/**
 * CORS options accepted by `BunHttpAdapter.enableCors()`. Semantics match
 * @nestjs/platform-express + the `cors` package, except `origin` functions
 * are called synchronously with the request (async forms unsupported).
 */
export interface CorsOptions {
  origin?:
    | string
    | boolean
    | RegExp
    | Array<string | RegExp>
    | ((req: BunRequest) => string | boolean | null | undefined);
  methods?: string | string[];
  credentials?: boolean;
  allowedHeaders?: string | string[];
  exposedHeaders?: string | string[];
  maxAge?: number;
}

export function applyCorsHeaders(
  req: BunRequest,
  res: BunResponse,
  options: CorsOptions | true,
): void {
  const opts: CorsOptions = options === true ? {} : options;
  const h = res.headers;
  const reqOrigin = req.headers['origin'];

  // Resolve `origin` to a concrete header value.
  //   * `string`         → echoed verbatim
  //   * `string[]`       → echo request origin if it's in the list, else omit
  //   * `RegExp`         → echo request origin if it matches, else omit
  //   * `true`           → echo the request's Origin (or '*' if absent),
  //                        which is also required when `credentials: true`
  //                        because browsers reject `*` in that combination.
  //   * `function(req)`  → invoked with the request, return value is treated
  //                        as one of the above.
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
