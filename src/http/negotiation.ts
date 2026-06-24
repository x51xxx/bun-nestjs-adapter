/**
 * Minimal HTTP content-negotiation (Accept / Accept-Encoding / Accept-Language)
 * and `Content-Type` matching, implementing the Express `req.accepts*` / `req.is`
 * surface without the `accepts` / `negotiator` / `type-is` dependencies.
 */

interface Spec {
  value: string;
  q: number;
}

/** Common Express type shorthands accepted by `accepts()` / `req.is()`. */
const SHORTHAND: Record<string, string> = {
  html: 'text/html',
  json: 'application/json',
  text: 'text/plain',
  xml: 'application/xml',
  js: 'application/javascript',
  css: 'text/css',
  csv: 'text/csv',
  form: 'application/x-www-form-urlencoded',
  urlencoded: 'application/x-www-form-urlencoded',
  multipart: 'multipart/form-data',
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  bin: 'application/octet-stream',
};

function toMime(type: string): string {
  if (type.includes('/')) return type.toLowerCase();
  return (SHORTHAND[type] ?? type).toLowerCase();
}

function parseList(header: string | undefined): Spec[] {
  if (!header) return [];
  const out: Spec[] = [];
  for (const part of header.split(',')) {
    const segs = part.trim().split(';');
    const value = segs[0].trim().toLowerCase();
    if (!value) continue;
    let q = 1;
    for (let i = 1; i < segs.length; i++) {
      const m = segs[i].trim().match(/^q=([0-9.]+)$/i);
      if (m) q = Number.parseFloat(m[1]);
    }
    out.push({ value, q });
  }
  return out;
}

// Media-type match specificity: -1 none, 0 = */*, 1 = type/*, 2 = exact.
function mediaSpecificity(provided: string, accept: string): number {
  if (accept === '*/*' || accept === '*') return 0;
  const [pt, ps] = provided.split('/');
  const [at, as] = accept.split('/');
  if (at === '*') return 0;
  if (at !== pt) return -1;
  if (as === '*') return 1;
  return as === ps ? 2 : -1;
}

/**
 * Pick the best of `offered` against an `Accept` header, returning the matched
 * offered token (preserving its original shorthand) or `false`. With no header,
 * the first offered type wins (Express semantics).
 */
export function accepts(header: string | undefined, offered: string[]): string | false {
  if (offered.length === 0) return false;
  const specs = parseList(header);
  if (specs.length === 0) return offered[0];

  let best: { token: string; q: number; order: number } | null = null;
  for (let i = 0; i < offered.length; i++) {
    const mime = toMime(offered[i]);
    // Use the q of the most-specific matching spec (so `text/html;q=0` rejects
    // even when a broad `*/*;q=1` is also present).
    let chosenSpecificity = -1;
    let q = 0;
    for (const spec of specs) {
      const s = mediaSpecificity(mime, spec.value);
      if (s > chosenSpecificity) {
        chosenSpecificity = s;
        q = spec.q;
      }
    }
    if (q > 0 && (!best || q > best.q)) {
      best = { token: offered[i], q, order: i };
    }
  }
  return best ? best.token : false;
}

/** Token-list negotiation for Accept-Encoding / Accept-Language. */
function acceptsToken(
  header: string | undefined,
  offered: string[],
  identityDefault: boolean,
): string | false {
  if (offered.length === 0) return false;
  const specs = parseList(header);
  if (specs.length === 0) return offered[0];

  let best: { token: string; q: number } | null = null;
  for (const token of offered) {
    const lower = token.toLowerCase();
    let q = 0;
    let matched = false;
    for (const spec of specs) {
      if (spec.value === lower) {
        q = spec.q;
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Honour a wildcard, but a language like `en-US` also matches `en`.
      const wildcard = specs.find(s => s.value === '*');
      if (wildcard) {
        q = wildcard.q;
        matched = true;
      } else {
        const base = lower.split('-')[0];
        const baseMatch = specs.find(s => s.value === base);
        if (baseMatch) {
          q = baseMatch.q;
          matched = true;
        }
      }
    }
    if (matched && q > 0 && (!best || q > best.q)) best = { token, q };
  }
  if (best) return best.token;
  // `identity` (no encoding) is implicitly acceptable unless explicitly q=0.
  if (identityDefault && offered.some(o => o.toLowerCase() === 'identity')) {
    const idSpec = specs.find(s => s.value === 'identity');
    if (!idSpec || idSpec.q > 0) return 'identity';
  }
  return false;
}

export function acceptsEncodings(
  header: string | undefined,
  offered: string[],
): string | false {
  return acceptsToken(header, offered, true);
}

export function acceptsLanguages(
  header: string | undefined,
  offered: string[],
): string | false {
  return acceptsToken(header, offered, false);
}

/**
 * `req.is(types)` — does the request's `Content-Type` match any of `types`?
 * Returns the matched type (original token) or `false`; `null` when there is
 * no body / Content-Type.
 */
export function typeIs(
  contentType: string | undefined,
  types: string[],
): string | false | null {
  if (!contentType) return null;
  const actual = contentType.split(';', 1)[0].trim().toLowerCase();
  if (!actual) return null;
  for (const type of types) {
    const mime = toMime(type.startsWith('+') ? `*/${type.slice(1)}` : type);
    if (mediaSpecificity(actual, mime) >= 0) return type;
  }
  return false;
}
