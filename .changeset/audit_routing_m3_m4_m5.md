---
'@trishchuk/bun-nestjs-adapter': patch
---

Make routing behave identically on both dispatchers: wildcard captures, middleware prefix boundaries, and HEAD.

**Named wildcards (M3).** `@Get('files/*path')` matched on the native-routes
fast path but handed back `params: {}` — Bun's matcher accepts `*name` without
ever exposing the capture — and 404'd outright on the fallback `fetch`
dispatcher, where `compilePath` escaped `*path` as a literal. `compilePath` now
understands both `*name` and the optional `{*name}` form, and paths Bun can't
faithfully destructure are kept off the native route map so they fall through to
the manual dispatcher. Same handler, same params, either way.

The same exclusion covers every `:param` form Bun mis-parses (verified against
Bun 1.3.5): `:id?` isn't optional and lands under the key `id?`, `:id(\d+)`
exposes the key `id(\d+)` without enforcing the pattern, and `:a-:b` collapses to
one key. Routes using those forms — and named wildcards — are therefore served by
the `fetch` dispatcher rather than Bun's native matcher.

**Optional params (L1).** `/opt/:id?` now matches both `/opt/5` and `/opt`; the
`?` used to be stripped from the key name while the regex group stayed required.

**Middleware prefix boundaries (M4).** `forRoutes('user')` / `use('/user', …)`
matched with a bare `startsWith`, so the middleware also ran for `/users` and
`/user-admin`. Prefix matching is now boundary-aware and shared with static-asset
mounts, which already implemented it correctly.

**HEAD (M5).** A `HEAD` request against a `GET`-only route returned 404 on both
dispatchers, breaking health checks, `curl -I` and link checkers. `HEAD` now falls
back to the `GET` handler the way Express and Fastify do, while an explicitly
registered `@Head()` route still wins. Bun strips the response body for `HEAD`
itself, so headers (including `content-length`) stay correct.

Because that fallback lets `HEAD` reach streaming routes, the response shim now
refuses to open a `ReadableStream` for a `HEAD` request: it settles headers-only
and emits `'close'` on the request. Without it, `HEAD` against an `@Sse()` route
left the observable producing into a buffer nobody drained, forever.
