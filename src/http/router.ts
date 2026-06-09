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
    const upper = method;
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
  const out = segments
    .map(seg => {
      if (seg.startsWith(':')) {
        const name = seg.slice(1).replace(/[?(].*$/, '');
        keys.push({ name });
        return '([^/]+)';
      }
      if (seg === '*' || seg === '(.*)') {
        return '.*';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  const regexp = new RegExp('^/' + out + '/?$');
  return { regexp, keys };
}

export function toBunRoutePath(path: string): string {
  // Bun.serve route syntax accepts `:param` and `*` directly. Normalise empty
  // path to `/` and strip trailing slash for consistency.
  if (!path) return '/';
  if (!path.startsWith('/')) path = '/' + path;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}
