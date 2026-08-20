---
'@trishchuk/bun-nestjs-adapter': minor
---

Add `useStaticAssets(root, { native: true })` — serve a static root through Bun 1.4.0's native `{ dir }` route.

A classic static mount is handled inside the manual `fetch` dispatcher, which
means registering one drops the **whole app** off the `Bun.serve({ routes })`
fast path. Bun 1.4.0 added directory routes, so the mount can instead become a
`{ dir }` entry in the route map. Measured locally with k6 (50 VUs, both
orders): serving the files goes from ~18.6k to ~35–40k RPS, and ordinary API
routes in the same app recover ~3% by getting the fast path back.

Opt-in, because the native route is not semantically identical to the classic
mount: routes are matched **before** the directory (rather than static-first), a
miss under the prefix is a hard empty `404` instead of falling through to Nest's
JSON 404, every method serves the file (not just `GET`/`HEAD`), and a directory
addressed without a trailing slash answers `301`. What it adds: a weak `ETag`,
`Last-Modified`, and `304` for `If-None-Match` / `If-Modified-Since`.

Because those semantics must hold on **both** dispatchers, `serveNativeStatic()`
mirrors them for requests that reach the manual `fetch` path (any app with
middleware or CORS). `tests/integration/static-native.spec.ts` runs one
assertion table against both, and pins the single divergence the adapter cannot
close: Bun resolves dot-segments in `Request.url` before the `fetch` callback
runs, so an in-root `%2e%2e` is a `404` natively and a collapsed `200` on the
manual dispatcher. No path escapes `root` on either dispatcher.

On Bun < 1.4.0 the flag warns and falls back to the classic mount, so the
package's `>=1.2.0` engines floor is unchanged.
