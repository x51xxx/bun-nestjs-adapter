import { promises as fs } from 'fs';
import { extname, join, normalize, sep } from 'path';
import { toResponseInit } from './response';
import { matchesPathPrefix } from './router';
import { BunResponse } from './types';

export interface StaticEntry {
  prefix: string;
  root: string;
  index: string;
  /**
   * Serve through Bun's native `{ dir }` route instead of this module's
   * classic path. Opt-in: the semantics differ (see `serveNativeStatic`),
   * but the entry no longer forces the manual `fetch` dispatcher.
   */
  native: boolean;
}

export const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

export interface StaticMatch {
  entry: StaticEntry;
  /** Suffix with `entry.index` already appended for a trailing slash. */
  relPath: string;
  /** Suffix exactly as it appeared in the URL — still percent-encoded. */
  rawRel: string;
}

export function matchStatic(
  staticAssets: StaticEntry[],
  pathname: string,
): StaticMatch | null {
  for (const entry of staticAssets) {
    const prefix = entry.prefix === '/' ? '' : entry.prefix;
    // `/static` must match `/static`, `/static/`, `/static/foo`, but NOT
    // `/static-admin/foo`.
    if (prefix && !matchesPathPrefix(pathname, prefix)) continue;
    const rawRel = pathname.slice(prefix.length) || '/';
    let rel = rawRel;
    if (rel.endsWith('/')) rel += entry.index;
    return { entry, relPath: rel, rawRel };
  }
  return null;
}

function finishEmpty(res: BunResponse, status: number): void {
  res.statusCode = status;
  res.finished = true;
  res.headersSent = true;
  res._resolve(new Response(null, toResponseInit(res.headers, status)));
}

/**
 * Serve a file from a static entry. Returns `true` when the request was
 * handled (file served, or 403 on traversal). Returns `false` on a miss
 * (no such file / path is a directory) so the caller can fall through to
 * route dispatch.
 */
export async function serveStatic(
  matched: StaticMatch,
  res: BunResponse,
): Promise<boolean> {
  const safe = normalize(matched.relPath).replace(/^[/\\]+/, '');
  if (safe.includes('..' + sep) || safe === '..') {
    finishEmpty(res, 403);
    return true;
  }
  const filePath = join(matched.entry.root, safe);
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      return false;
    }
    if (typeof Bun === 'undefined' || typeof Bun.file !== 'function') {
      finishEmpty(res, 500);
      return true;
    }
    const file = Bun.file(filePath);
    const ext = extname(filePath).toLowerCase();
    const mime = STATIC_MIME[ext] ?? 'application/octet-stream';
    res.headers['content-type'] = mime;
    res.headers['content-length'] = String(stat.size);
    res.finished = true;
    res.headersSent = true;
    res._resolve(new Response(file, toResponseInit(res.headers, res.statusCode || 200)));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

// ─── native (`Bun.serve({ routes: { '/p/*': { dir } } })`) emulation ────────
//
// The native route only exists on the hot path. Everything that Bun's matcher
// leaves to `fetch` — a path the dir route never sees, or the whole app once
// middleware/CORS force the manual dispatcher — has to behave *identically*
// here, or the two dispatchers would disagree. So this mirrors Bun 1.4's
// documented contract: decode the suffix once, reject non-canonical paths with
// 404, weak `ETag` + `Last-Modified` + conditional 304, `301` to the
// trailing-slash form for a directory, `index.html` inside it, 404 for a miss
// (no fallthrough to route dispatch), and no method gate.

/** `/` → `/*`, `/static` → `/static/*` — the only shape Bun's `dir` accepts. */
export function bunDirRoutePath(prefix: string): string {
  const clean = prefix === '/' || prefix === '' ? '' : prefix.replace(/\/+$/, '');
  return clean + '/*';
}

/**
 * Percent-decode one path suffix the way Bun's dir route does: exactly once,
 * per segment, rejecting anything non-canonical. Returns `null` when the path
 * must 404 — an empty, `.` or `..` segment, or an escape (`%2F`, `%00`, `\`)
 * that would let the decoded path address a file the router never matched.
 */
export function decodeStaticSuffix(rawRel: string): string[] | null {
  const out: string[] = [];
  for (const rawSeg of rawRel.split('/')) {
    if (rawSeg === '') continue;
    let seg: string;
    try {
      seg = decodeURIComponent(rawSeg);
    } catch {
      return null;
    }
    if (seg === '.' || seg === '..' || seg === '') return null;
    if (seg.includes('/') || seg.includes('\\') || seg.includes('\0')) return null;
    out.push(seg);
  }
  return out;
}

/** Bun's weak validator: `W/"<size-hex>-<mtime-seconds-hex>"`. */
export function fileEtag(size: number, mtimeMs: number): string {
  return `W/"${size.toString(16)}-${Math.floor(mtimeMs / 1000).toString(16)}"`;
}

function weakMatch(ifNoneMatch: string, etag: string): boolean {
  const bare = (v: string) => v.trim().replace(/^W\//, '');
  if (ifNoneMatch.trim() === '*') return true;
  return ifNoneMatch.split(',').some(v => bare(v) === bare(etag));
}

function notModified(res: BunResponse, etag: string, lastModified: string): void {
  res.headers.etag = etag;
  res.headers['last-modified'] = lastModified;
  finishEmpty(res, 304);
}

function redirect(res: BunResponse, location: string): void {
  res.headers.location = location;
  finishEmpty(res, 301);
}

function headerOf(
  req: { headers: Record<string, unknown> },
  name: string,
): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : Array.isArray(v) ? (v[0] as string) : undefined;
}

/**
 * Slow-path twin of Bun's `{ dir }` route. Always settles the response — a
 * miss is a hard 404, never a fallthrough, because that is what the native
 * route does once it has matched the prefix.
 */
export async function serveNativeStatic(
  matched: StaticMatch,
  req: { method: string; headers: Record<string, unknown> },
  res: BunResponse,
  pathname: string,
  search = '',
): Promise<void> {
  const segments = decodeStaticSuffix(matched.rawRel);
  if (segments === null) return finishEmpty(res, 404);

  const filePath = join(matched.entry.root, ...segments);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return finishEmpty(res, 404);
    if ((err as NodeJS.ErrnoException)?.code === 'ENOTDIR') return finishEmpty(res, 404);
    throw err;
  }

  let target = filePath;
  let targetStat = stat;
  if (stat.isDirectory()) {
    // A directory addressed without the trailing slash redirects, so the
    // relative links inside the index page resolve against the right base.
    if (!matched.rawRel.endsWith('/')) return redirect(res, pathname + '/' + search);
    target = join(filePath, matched.entry.index);
    try {
      targetStat = await fs.stat(target);
    } catch {
      return finishEmpty(res, 404);
    }
    if (targetStat.isDirectory()) return finishEmpty(res, 404);
  }

  const etag = fileEtag(targetStat.size, targetStat.mtimeMs);
  const lastModified = new Date(
    Math.floor(targetStat.mtimeMs / 1000) * 1000,
  ).toUTCString();

  const inm = headerOf(req, 'if-none-match');
  if (inm && weakMatch(inm, etag)) return notModified(res, etag, lastModified);
  const ims = headerOf(req, 'if-modified-since');
  if (!inm && ims) {
    const since = Date.parse(ims);
    if (!Number.isNaN(since) && Math.floor(targetStat.mtimeMs / 1000) * 1000 <= since) {
      return notModified(res, etag, lastModified);
    }
  }

  if (typeof Bun === 'undefined' || typeof Bun.file !== 'function') {
    return finishEmpty(res, 500);
  }
  const file = Bun.file(target);
  // Take the content type from `Bun.file` rather than our own table so both
  // dispatchers label the same file identically.
  res.headers['content-type'] =
    file.type || STATIC_MIME[extname(target).toLowerCase()] || 'application/octet-stream';
  res.headers.etag = etag;
  res.headers['last-modified'] = lastModified;
  res.headers['accept-ranges'] = 'bytes';
  res.finished = true;
  res.headersSent = true;
  // No explicit content-length: Bun derives it, and rewrites it for a 206 when
  // the request carried a `Range` (1.4.0+ handles that for `Bun.file` bodies).
  res._resolve(new Response(file, toResponseInit(res.headers, res.statusCode || 200)));
}
