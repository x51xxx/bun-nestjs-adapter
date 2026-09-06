import { BunRouteHandler, EMPTY_PARAMS } from './types';

export interface CompiledRoute {
  method: string;
  rawPath: string;
  regexp: RegExp;
  keys: { name: string }[];
  handler: BunRouteHandler;
  /**
   * Registration index. `matchAll()` returns candidates in registration order
   * across methods, and the per-method buckets it merges are each ordered on
   * their own — this is what lets them be merged without re-sorting.
   */
  order: number;
}

export class BunRouterInstance {
  public readonly routes: CompiledRoute[] = [];
  public readonly middleware: Array<{
    prefix: string;
    handler: BunRouteHandler;
  }> = [];
  /**
   * `path → method → handler[]`. Mirrors `routes` but indexed for native
   * Bun.serve `routes:` config — built once on listen().
   */
  public readonly byPath: Map<string, Map<string, BunRouteHandler[]>> = new Map();
  /**
   * `method → routes`, so a request only ever tests the regexes registered for
   * its own verb. Matching used to run every compiled regex in the application
   * against every request on the manual dispatcher; an app with 200 routes
   * spread over the usual verbs now tests a fraction of them.
   */
  private readonly byMethod: Map<string, CompiledRoute[]> = new Map();
  /** `ALL` routes, which are candidates for every verb. Usually empty. */
  private readonly allMethodRoutes: CompiledRoute[] = [];

  add(method: string, path: string, handler: BunRouteHandler) {
    const upper = method.toUpperCase();
    const { regexp, keys } = compilePath(path);
    const route: CompiledRoute = {
      method: upper,
      rawPath: path,
      regexp,
      keys,
      handler,
      order: this.routes.length,
    };
    this.routes.push(route);
    if (upper === 'ALL') {
      this.allMethodRoutes.push(route);
    } else {
      const bucketForMethod = this.byMethod.get(upper);
      if (bucketForMethod) bucketForMethod.push(route);
      else this.byMethod.set(upper, [route]);
    }
    let bucket = this.byPath.get(path);
    if (!bucket) {
      bucket = new Map();
      this.byPath.set(path, bucket);
    }
    let arr = bucket.get(upper);
    if (!arr) {
      arr = [];
      bucket.set(upper, arr);
    }
    arr.push(handler);
  }

  use(prefix: string, handler: BunRouteHandler) {
    this.middleware.push({ prefix, handler });
  }

  matchAll(method: string, pathname: string) {
    const matches = this.collect(method, pathname);
    // HEAD falls back to the GET handlers when nothing explicit matched —
    // Express and Fastify both do this, and Bun strips the response body for
    // HEAD on its own. An explicitly registered `@Head()` route still wins,
    // because it is only after an empty first pass that we retry.
    if (matches.length === 0 && method === 'HEAD') {
      return this.collect('GET', pathname);
    }
    return matches;
  }

  /**
   * Handlers registered for one raw path that apply to `method`, in
   * registration order — `ALL` and method-specific interleaved exactly as they
   * were declared. The native route map needs this because it collapses a path
   * with an `ALL` handler into a single function route and has to rebuild the
   * chain itself; `byPath` groups by method and so loses the cross-method
   * order.
   */
  orderedHandlers(rawPath: string, method: string): BunRouteHandler[] {
    const out: BunRouteHandler[] = [];
    for (let i = 0; i < this.routes.length; i++) {
      const route = this.routes[i];
      if (route.rawPath !== rawPath) continue;
      if (route.method !== method && route.method !== 'ALL') continue;
      out.push(route.handler);
    }
    return out;
  }

  /**
   * Candidates for one verb, in registration order. The verb's own bucket and
   * the `ALL` bucket are each already ordered, so they are walked together with
   * two cursors rather than concatenated and sorted.
   */
  private collect(upper: string, pathname: string) {
    const specific = this.byMethod.get(upper);
    const all = this.allMethodRoutes;
    const matches: { route: CompiledRoute; params: Record<string, string> }[] = [];

    if (all.length === 0) {
      if (specific === undefined) return matches;
      for (let i = 0; i < specific.length; i++) {
        this.tryRoute(specific[i], pathname, matches);
      }
      return matches;
    }
    if (specific === undefined) {
      for (let i = 0; i < all.length; i++) {
        this.tryRoute(all[i], pathname, matches);
      }
      return matches;
    }
    let a = 0;
    let b = 0;
    while (a < specific.length && b < all.length) {
      if (specific[a].order < all[b].order)
        this.tryRoute(specific[a++], pathname, matches);
      else this.tryRoute(all[b++], pathname, matches);
    }
    while (a < specific.length) this.tryRoute(specific[a++], pathname, matches);
    while (b < all.length) this.tryRoute(all[b++], pathname, matches);
    return matches;
  }

  private tryRoute(
    route: CompiledRoute,
    pathname: string,
    out: { route: CompiledRoute; params: Record<string, string> }[],
  ): void {
    const m = route.regexp.exec(pathname);
    if (!m) return;
    let params: Record<string, string>;
    if (route.keys.length === 0) {
      params = EMPTY_PARAMS;
    } else {
      params = Object.create(null);
      for (let i = 0; i < route.keys.length; i++) {
        const v = m[i + 1];
        if (v !== undefined) params[route.keys[i].name] = safeDecodeURIComponent(v);
      }
    }
    out.push({ route, params });
  }
}

/**
 * Boundary-aware path-prefix match — `/user` covers `/user`, `/user/` and
 * `/user/edit`, but NOT `/users`. Shared by `use()` middleware dispatch and
 * static-asset mounts, which both used to (or still would) get this subtly
 * wrong with a bare `startsWith`.
 *
 * `/` is the match-everything prefix.
 */
export function matchesPathPrefix(pathname: string, prefix: string): boolean {
  if (prefix === '/' || prefix === '') return true;
  if (!pathname.startsWith(prefix)) return false;
  // 0x2F = '/'. NaN means we're at the end of the string (exact match).
  const next = pathname.charCodeAt(prefix.length);
  return Number.isNaN(next) || next === 0x2f;
}

/**
 * `decodeURIComponent` that tolerates malformed percent-encoding (`/users/%zz`)
 * by returning the raw value instead of throwing a URIError — a crash here
 * would turn a bad client URL into a 500.
 */
export function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function compilePath(path: string): {
  regexp: RegExp;
  keys: { name: string }[];
} {
  if (
    path === '*' ||
    path === '/*' ||
    path === '/(.*)' ||
    path === '(.*)' ||
    path === '/(.*)?'
  ) {
    return { regexp: /^\/.*$/, keys: [] };
  }
  if (path === '/' || path === '') {
    return { regexp: /^\/?$/, keys: [] };
  }
  const keys: { name: string }[] = [];
  const cleaned = path.startsWith('/') ? path : '/' + path;
  const segments = cleaned.split('/').filter(Boolean);
  // Each part carries its own leading '/' so an optional wildcard can swallow
  // the separator too (`/a/{*rest}` has to match a bare `/a`).
  const parts = segments.map(seg => {
    // A segment that is *nothing but* one param — by far the common case.
    const whole = WHOLE_PARAM.exec(seg);
    if (whole) {
      keys.push({ name: whole[1] });
      // A trailing `?` marks the param optional (`/opt/:id?` must also match
      // `/opt`), so the separator goes inside the optional group.
      return whole[3] ? '(?:/([^/]+))?' : '/([^/]+)';
    }
    // path-to-regexp v8 / Nest 11 named wildcards. `{*name}` is the optional
    // form (matches zero or more segments), `*name` the required one. Nest
    // forwards these verbatim from the controller decorator.
    const optionalWildcard = OPTIONAL_WILDCARD.exec(seg);
    if (optionalWildcard) {
      keys.push({ name: optionalWildcard[1] });
      return '(?:/(.*))?';
    }
    const namedWildcard = NAMED_WILDCARD.exec(seg);
    if (namedWildcard) {
      keys.push({ name: namedWildcard[1] });
      return '/(.+)';
    }
    if (seg === '*' || seg === '(.*)') {
      return '/.*';
    }
    // Several params in one segment, with literal separators between them:
    // `/x/:a-:b`, `/v:major.:minor`. path-to-regexp handles these and so does
    // Nest, but this used to fall through to the escape branch below and match
    // the literal text `:a-:b`.
    if (seg.includes(':')) {
      return '/' + compileMixedSegment(seg, keys);
    }
    return '/' + escapeLiteral(seg);
  });
  const regexp = new RegExp('^' + parts.join('') + '/?$');
  return { regexp, keys };
}

const OPTIONAL_WILDCARD = /^\{\*([A-Za-z0-9_$]+)\}$/;
const NAMED_WILDCARD = /^\*([A-Za-z0-9_$]+)$/;
/** `:name`, optionally with a `(pattern)` and/or a trailing `?`, and nothing else. */
const WHOLE_PARAM = /^:([A-Za-z0-9_$]+)(\([^)]*\))?(\?)?$/;
/** The same, at the current position inside a longer segment. */
const PARAM_AT = /^:([A-Za-z0-9_$]+)(\([^)]*\))?/;

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a segment that mixes params with literal text, e.g. `:a-:b` or
 * `v:major.:minor`. Groups are greedy, which is what path-to-regexp produces:
 * `/x/foo-bar-baz` against `/x/:a-:b` yields `a = 'foo-bar'`, `b = 'baz'`
 * (verified against @nestjs/platform-express).
 *
 * An inline `(pattern)` is consumed but not enforced, matching what the
 * whole-segment branch does with it.
 */
function compileMixedSegment(seg: string, keys: { name: string }[]): string {
  let out = '';
  let i = 0;
  while (i < seg.length) {
    if (seg[i] === ':') {
      const param = PARAM_AT.exec(seg.slice(i));
      if (param) {
        keys.push({ name: param[1] });
        out += '([^/]+)';
        i += param[0].length;
        continue;
      }
    }
    out += escapeLiteral(seg[i]);
    i++;
  }
  return out;
}

/**
 * True when Bun's native matcher can't faithfully destructure the path. Bun
 * understands plain `:param` (and exposes it) and bare `*` (nothing to expose),
 * but:
 *
 *   * `*name` — matches, yet hands back an empty `params` object, so the
 *     capture is silently lost;
 *   * any `:param` that isn't a bare identifier — Bun takes the rest of the
 *     segment as part of the *name*. Verified against Bun 1.3.5 and 1.4.0:
 *     `/p/:id(\d+)` exposes the key `id(\d+)` and doesn't enforce the pattern
 *     (`/p/abc` matches); `/x/:a-:b` collapses to a single key `b` holding
 *     `a-b`; `/opt/:id?` isn't optional and lands under the key `id?`.
 *
 * Those paths stay off the native route map. Bun then falls through to the
 * `fetch` callback, which routes them through our own compiled regex — same
 * handler, same params, on both dispatchers.
 */
export function bunRoutesLoseParams(path: string): boolean {
  if (NAMED_WILDCARD_ANYWHERE.test(path)) return true;
  for (const seg of path.split('/')) {
    // Not just `startsWith(':')`: a segment that merely *contains* a param
    // (`v:major.:minor`) is one Bun's matcher does not understand either — it
    // matched nothing at all when tested on 1.4.0.
    if (seg.includes(':') && !BARE_PARAM.test(seg)) return true;
  }
  return false;
}

const NAMED_WILDCARD_ANYWHERE = /(^|\/)\{?\*[A-Za-z0-9_$]+\}?(\/|$)/;
const BARE_PARAM = /^:[A-Za-z0-9_$]+$/;

/**
 * The verbs `Bun.serve({ routes })` accepts as method keys on a route object.
 * Anything else — SEARCH, the new-in-Nest-12 QUERY, and the WebDAV verbs —
 * makes Bun throw `ERR_INVALID_ARG_TYPE` out of `Bun.serve()` itself, which
 * takes the whole app down at `listen()` rather than 404ing one route.
 *
 * Bun falls through to the `fetch` callback for any method a route object
 * doesn't list, so dropping just the offending key keeps the path (and its
 * standard verbs) on the native map while the odd verb is served by the manual
 * dispatcher, which matches on the raw method string. `ALL` is deliberately
 * absent: `buildBunRoutes()` collapses it into a bare function route, which
 * Bun invokes for every method.
 */
const BUN_NATIVE_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
]);

export function isBunNativeMethod(method: string): boolean {
  return BUN_NATIVE_METHODS.has(method);
}

export function toBunRoutePath(path: string): string {
  // Bun.serve route syntax accepts `:param` and `*` directly. Normalise empty
  // path to `/` and strip trailing slash for consistency.
  if (!path) return '/';
  if (!path.startsWith('/')) path = '/' + path;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}
