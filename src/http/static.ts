import { promises as fs } from 'fs';
import { extname, join, normalize, sep } from 'path';
import { toResponseInit } from './response';
import { BunRequest, BunResponse } from './types';

export interface StaticEntry {
  prefix: string;
  root: string;
  index: string;
  /** Optional `Cache-Control` value emitted for served files. */
  cacheControl?: string;
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
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export interface StaticMatch {
  entry: StaticEntry;
  relPath: string;
}

export function matchStatic(
  staticAssets: StaticEntry[],
  pathname: string,
): StaticMatch | null {
  for (const entry of staticAssets) {
    const prefix = entry.prefix === '/' ? '' : entry.prefix;
    if (prefix) {
      // Boundary-aware prefix match: `/static` must match `/static`,
      // `/static/`, `/static/foo`, but NOT `/static-admin/foo`.
      if (!pathname.startsWith(prefix)) continue;
      const next = pathname.charCodeAt(prefix.length);
      // 0x2F = '/'.  NaN means we're at the end of the string (exact match).
      if (!Number.isNaN(next) && next !== 0x2f) continue;
    }
    let rel = pathname.slice(prefix.length) || '/';
    if (rel.endsWith('/')) rel += entry.index;
    return { entry, relPath: rel };
  }
  return null;
}

function finishEmpty(res: BunResponse, status: number): void {
  res.statusCode = status;
  res.finished = true;
  res.headersSent = true;
  res._resolve(new Response(null, toResponseInit(res.headers, status)));
}

/** Weak ETag from size + mtime — matches Express' default `etag` shape closely. */
function computeEtag(size: number, mtimeMs: number): string {
  return `W/"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

/** `If-None-Match` matcher: `*`, exact, or comma-separated list membership. */
function etagMatches(ifNoneMatch: string, etag: string): boolean {
  const trimmed = ifNoneMatch.trim();
  if (trimmed === '*') return true;
  return trimmed
    .split(',')
    .some(
      tag =>
        tag.trim() === etag || tag.trim() === `W/${etag}` || `W/${tag.trim()}` === etag,
    );
}

/**
 * Parse a single-range `Range: bytes=start-end` header against a known size.
 * Returns the inclusive [start, end] pair, `null` when there is no/!bytes
 * range header, or `'invalid'` when the range is unsatisfiable (→ 416).
 * Multi-range requests fall back to a full 200 response (returns `null`).
 */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | 'invalid' {
  if (!header || !header.startsWith('bytes=')) return null;
  const spec = header.slice(6);
  if (spec.includes(',')) return null; // multi-range — serve full body
  const dash = spec.indexOf('-');
  if (dash === -1) return 'invalid';
  const startStr = spec.slice(0, dash).trim();
  const endStr = spec.slice(dash + 1).trim();

  let start: number;
  let end: number;
  if (startStr === '') {
    // Suffix range: last N bytes.
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === '' ? size - 1 : Number(endStr);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
    if (end > size - 1) end = size - 1;
  }
  if (start > end || start >= size || start < 0) return 'invalid';
  return { start, end };
}

/**
 * Serve a file from a static entry with conditional-request, byte-range and
 * caching support. Returns `true` when the request was handled (file served,
 * 304, 206, 403, or 416). Returns `false` on a miss (no such file / path is a
 * directory) so the caller can fall through to route dispatch.
 */
export async function serveStatic(
  matched: StaticMatch,
  res: BunResponse,
  req?: BunRequest,
): Promise<boolean> {
  const safe = normalize(matched.relPath).replace(/^[/\\]+/, '');
  if (safe.includes('..' + sep) || safe === '..') {
    finishEmpty(res, 403);
    return true;
  }
  const filePath = join(matched.entry.root, safe);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
  if (stat.isDirectory()) {
    return false;
  }
  if (typeof Bun === 'undefined' || typeof Bun.file !== 'function') {
    finishEmpty(res, 500);
    return true;
  }

  const size = stat.size;
  const etag = computeEtag(size, stat.mtimeMs);
  const lastModified = stat.mtime.toUTCString();
  const ext = extname(filePath).toLowerCase();
  const mime = STATIC_MIME[ext] ?? 'application/octet-stream';

  const headers = res.headers;
  headers['content-type'] = mime;
  headers['etag'] = etag;
  headers['last-modified'] = lastModified;
  headers['accept-ranges'] = 'bytes';
  if (matched.entry.cacheControl) {
    headers['cache-control'] = matched.entry.cacheControl;
  }

  const reqHeaders = req?.headers;
  const method = req?.method ?? 'GET';

  // Conditional GET — `If-None-Match` wins over `If-Modified-Since` (RFC 9110).
  const inm = reqHeaders?.['if-none-match'];
  const ims = reqHeaders?.['if-modified-since'];
  const notModified =
    (inm !== undefined && etagMatches(inm, etag)) ||
    (inm === undefined &&
      ims !== undefined &&
      Number.isFinite(Date.parse(ims)) &&
      stat.mtime.getTime() <= Date.parse(ims) + 999);
  if (notModified) {
    finishEmpty(res, 304);
    return true;
  }

  const file = Bun.file(filePath);

  // Range request (skip for HEAD — no body to slice).
  const range = method === 'HEAD' ? null : parseRange(reqHeaders?.['range'], size);
  if (range === 'invalid') {
    headers['content-range'] = `bytes */${size}`;
    finishEmpty(res, 416);
    return true;
  }

  res.finished = true;
  res.headersSent = true;

  if (method === 'HEAD') {
    headers['content-length'] = String(size);
    res._resolve(new Response(null, toResponseInit(headers, 200)));
    return true;
  }

  if (range) {
    const { start, end } = range;
    headers['content-range'] = `bytes ${start}-${end}/${size}`;
    headers['content-length'] = String(end - start + 1);
    res._resolve(new Response(file.slice(start, end + 1), toResponseInit(headers, 206)));
    return true;
  }

  headers['content-length'] = String(size);
  res._resolve(new Response(file, toResponseInit(headers, res.statusCode || 200)));
  return true;
}
