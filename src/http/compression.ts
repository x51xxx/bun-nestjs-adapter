/**
 * Native response compression using Bun's built-in codecs
 * (`Bun.gzipSync` / `Bun.deflateSync` / `Bun.zstdCompressSync`) — no Node
 * `zlib` stream or the Express `compression` middleware required.
 *
 * Only buffered, text-like responses above a size threshold are compressed;
 * streaming responses (SSE, `StreamableFile`) are left untouched.
 */

export type CompressionEncoding = 'gzip' | 'deflate' | 'zstd';

export interface CompressionConfig {
  /** Minimum uncompressed byte length before compression kicks in. */
  threshold: number;
}

// Text-based media types worth compressing. Binary formats (images, video,
// fonts, wasm) are already compressed, so we skip them.
const COMPRESSIBLE =
  /^(?:text\/|application\/(?:json|ld\+json|javascript|manifest\+json|xml|xhtml\+xml|rss\+xml|atom\+xml|vnd\.api\+json)|image\/svg\+xml)/i;

export function isCompressible(contentType: string | string[] | undefined): boolean {
  if (!contentType) return false;
  const ct = Array.isArray(contentType) ? contentType[0] : contentType;
  return COMPRESSIBLE.test(ct);
}

/** Does the `Accept-Encoding` value accept `enc` (respecting an explicit `q=0`)? */
function accepts(acceptEncoding: string, enc: string): boolean {
  const re = new RegExp(`(?:^|,)\\s*${enc}\\b\\s*(?:;\\s*q=([0-9.]+))?`, 'i');
  const m = acceptEncoding.match(re);
  if (!m) return false;
  return m[1] === undefined || Number.parseFloat(m[1]) > 0;
}

/**
 * Pick an encoding from `Accept-Encoding`. Prefers `gzip` (universally
 * supported), then `zstd`, then `deflate`. Returns `null` when none apply.
 */
export function negotiateEncoding(
  acceptEncoding: string | undefined,
): CompressionEncoding | null {
  if (!acceptEncoding) return null;
  if (accepts(acceptEncoding, 'gzip')) return 'gzip';
  if (accepts(acceptEncoding, 'zstd')) return 'zstd';
  if (accepts(acceptEncoding, 'deflate')) return 'deflate';
  return null;
}

export function compress(encoding: CompressionEncoding, data: Uint8Array): Uint8Array {
  // Bun's codecs type the input as `Uint8Array<ArrayBuffer>`; a `TextEncoder`
  // result is the wider `Uint8Array<ArrayBufferLike>`. They are runtime-identical.
  const d = data as Uint8Array<ArrayBuffer>;
  switch (encoding) {
    case 'gzip':
      return Bun.gzipSync(d);
    case 'deflate':
      return Bun.deflateSync(d);
    case 'zstd':
      return Bun.zstdCompressSync(d);
  }
}

/** Merge `Accept-Encoding` into the `Vary` header without duplicating it. */
export function addVaryAcceptEncoding(headers: Record<string, string | string[]>): void {
  const existing = headers['vary'];
  if (existing === undefined) {
    headers['vary'] = 'Accept-Encoding';
    return;
  }
  const current = Array.isArray(existing) ? existing.join(', ') : existing;
  if (!/\baccept-encoding\b/i.test(current)) {
    headers['vary'] = `${current}, Accept-Encoding`;
  }
}
