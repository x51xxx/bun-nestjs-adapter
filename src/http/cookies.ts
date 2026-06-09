import { createHmac, timingSafeEqual } from 'crypto';
import { safeDecodeURIComponent } from './router';

export function signCookie(val: string, secret: string): string {
  const signature = createHmac('sha256', secret)
    .update(val)
    .digest('base64')
    .replace(/=+$/, '');
  return `s:${val}.${signature}`;
}

export function unsignCookie(val: string, secret: string): string | false {
  if (!val.startsWith('s:')) return false;
  const index = val.lastIndexOf('.');
  if (index === -1) return false;
  const actualVal = val.slice(2, index);
  const sig = val.slice(index + 1);
  const expectedSig = createHmac('sha256', secret)
    .update(actualVal)
    .digest('base64')
    .replace(/=+$/, '');

  // Constant-time compare — `timingSafeEqual` throws on unequal lengths, so
  // guard on length first (a length mismatch is already a definitive reject).
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length === b.length && timingSafeEqual(a, b)) return actualVal;
  return false;
}

// Mirror Express' JSONCookie: a `j:`-prefixed value was written by `res.cookie`
// with an object payload, so decode it back on read.
export function decodeCookieValue(val: string): unknown {
  if (val.startsWith('j:')) {
    try {
      return JSON.parse(val.slice(2));
    } catch {
      return val;
    }
  }
  return val;
}

// Shared frozen result reused for cookie-less requests — same hot-path
// no-allocation contract as EMPTY_QUERY / EMPTY_PARAMS.
const EMPTY_COOKIE_MAP: Record<string, unknown> = Object.freeze(Object.create(null));
const EMPTY_COOKIES = Object.freeze({
  cookies: EMPTY_COOKIE_MAP,
  signedCookies: EMPTY_COOKIE_MAP,
});

export function parseCookies(
  cookieHeader: string | undefined,
  secret: string | null,
): { cookies: Record<string, unknown>; signedCookies: Record<string, unknown> } {
  if (!cookieHeader) return EMPTY_COOKIES;

  const cookies: Record<string, unknown> = Object.create(null);
  const signedCookies: Record<string, unknown> = Object.create(null);
  const pairs = cookieHeader.split(';');
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = safeDecodeURIComponent(pair.slice(0, idx).trim());
    const val = safeDecodeURIComponent(pair.slice(idx + 1).trim());

    if (secret && val.startsWith('s:')) {
      const unsigned = unsignCookie(val, secret);
      if (unsigned !== false) {
        signedCookies[key] = decodeCookieValue(unsigned);
        continue;
      }
    }
    cookies[key] = decodeCookieValue(val);
  }
  return { cookies, signedCookies };
}
