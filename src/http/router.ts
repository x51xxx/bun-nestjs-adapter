import { BunRouteHandler, EMPTY_PARAMS } from './types';

export interface CompiledRoute {
  method: string;
  rawPath: string;
  regexp: RegExp;
  keys: { name: string }[];
  handler: BunRouteHandler;
  isMiddleware: boolean;
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

  add(method: string, path: string, handler: BunRouteHandler) {
    const upper = method.toUpperCase();
    const { regexp, keys } = compilePath(path);
    this.routes.push({
      method: upper,
      rawPath: path,
      regexp,
      keys,
      handler,
      isMiddleware: upper === 'USE',
    });
    if (upper === 'USE') return;
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

  private collect(upper: string, pathname: string) {
    const matches: { route: CompiledRoute; params: Record<string, string> }[] = [];
    for (const route of this.routes) {
      if (route.method !== upper && route.method !== 'ALL' && route.method !== 'USE')
        continue;
      const m = route.regexp.exec(pathname);
      if (!m) continue;
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
      matches.push({ route, params });
    }
    return matches;
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
    if (seg.startsWith(':')) {
      const name = seg.slice(1).replace(/[?(].*$/, '');
      keys.push({ name });
      // A trailing `?` marks the param optional (`/opt/:id?` must also match
      // `/opt`), so the separator goes inside the optional group.
      return seg.endsWith('?') ? '(?:/([^/]+))?' : '/([^/]+)';
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
    return '/' + seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  const regexp = new RegExp('^' + parts.join('') + '/?$');
  return { regexp, keys };
}

const OPTIONAL_WILDCARD = /^\{\*([A-Za-z0-9_$]+)\}$/;
const NAMED_WILDCARD = /^\*([A-Za-z0-9_$]+)$/;

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
    if (seg.startsWith(':') && !BARE_PARAM.test(seg)) return true;
  }
  return false;
}

const NAMED_WILDCARD_ANYWHERE = /(^|\/)\{?\*[A-Za-z0-9_$]+\}?(\/|$)/;
const BARE_PARAM = /^:[A-Za-z0-9_$]+$/;

export function toBunRoutePath(path: string): string {
  // Bun.serve route syntax accepts `:param` and `*` directly. Normalise empty
  // path to `/` and strip trailing slash for consistency.
  if (!path) return '/';
  if (!path.startsWith('/')) path = '/' + path;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}
