---
'@trishchuk/bun-nestjs-adapter': patch
---

Fix two defects found in the 2026-09-06 audit.

**SSE and other streamed responses no longer die after 10 seconds.**
`Bun.serve` closes a connection once `idleTimeout` seconds pass without traffic
(10 by default), so a `@Sse()` feed with a gap between events — the shape of
every heartbeat-less stream — was dropped by the runtime. Raising the option
globally is not a fix: Bun caps it at 255 seconds. The adapter now calls
`server.timeout(request, 0)` the moment a response upgrades to a stream, on both
dispatchers and for `StreamableFile` / bare `Readable` bodies too.

**`enableCors({ origin })` now accepts the `cors`-package callback signature.**
`origin: (requestOrigin, callback) => callback(null, true)` — the shape Nest's
own documentation shows — was called with the request object and a missing
callback, so no `Access-Control-Allow-Origin` was emitted at all while every
other CORS header still went out. Both function shapes are now supported, told
apart by arity, and a callback that is not invoked synchronously warns instead
of failing silently. Note for the one-argument `(req) => origin` form: because
`origin` is now a union of two function types with different arities,
TypeScript can no longer infer that parameter — annotate it as
`(req: BunRequest) => …` under `noImplicitAny`.
