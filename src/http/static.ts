import { promises as fs } from 'fs';
import { extname, join, normalize, sep } from 'path';
import { toResponseInit } from './response';
import { BunResponse } from './types';

export interface StaticEntry {
  prefix: string;
  root: string;
  index: string;
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
