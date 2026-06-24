/**
 * Native response compression using Bun's built-in codecs
 * (`Bun.gzipSync` / `Bun.deflateSync` / `Bun.zstdCompressSync`) plus Brotli via
 * `node:zlib` — no Express `compression` middleware required.
 *
 * Only buffered, text-like responses above a size threshold are compressed;
 * streaming responses (SSE, `StreamableFile`) are left untouched.
 */
import { BrotliOptions, brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { acceptsEncodings } from './negotiation';

export type CompressionEncoding = 'br' | 'gzip' | 'deflate' | 'zstd';

// Server preference order. Brotli first (best ratio for text); ties on the
// client side are broken by this order in `acceptsEncodings`.
const SUPPORTED: CompressionEncoding[] = ['br', 'gzip', 'zstd', 'deflate'];

// Moderate Brotli quality — full quality (11) is too slow for dynamic bodies.
const BROTLI_OPTS: BrotliOptions = {
  params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
};

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

/**
 * Pick an encoding from `Accept-Encoding`, q-value aware (via `acceptsEncodings`).
 * Server preference (`br` > `gzip` > `zstd` > `deflate`) breaks client ties.
 * Returns `null` when none apply.
 */
export function negotiateEncoding(
  acceptEncoding: string | undefined,
): CompressionEncoding | null {
  if (!acceptEncoding) return null;
  const chosen = acceptsEncodings(acceptEncoding, SUPPORTED as string[]);
  return chosen && chosen !== 'identity' ? (chosen as CompressionEncoding) : null;
}

export function compress(encoding: CompressionEncoding, data: Uint8Array): Uint8Array {
  // Bun's codecs type the input as `Uint8Array<ArrayBuffer>`; a `TextEncoder`
  // result is the wider `Uint8Array<ArrayBufferLike>`. They are runtime-identical.
  const d = data as Uint8Array<ArrayBuffer>;
  switch (encoding) {
    case 'br':
      return brotliCompressSync(d, BROTLI_OPTS);
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
