---
'@trishchuk/bun-nestjs-adapter': minor
---

Nest 12.1 support, response backpressure, and WebSocket tuning.

**`forceCloseConnections`.** The option was ignored: `close()` always waited for
Bun's `stop()` to drain, so `app.close()` hung for as long as an SSE or other
streaming client stayed connected. With `forceCloseConnections: true` it now
calls `stop(true)`; without it, close still waits, as express does.

**Nest 12.1 security hooks keep the fast path.** `app.useSecurityHeaders()` and
`app.enableCsrfProtection()` register through `registerSecurityHook()`, whose
base implementation is a `use()` middleware — which took every request off Bun's
native route map. The adapter now keeps the hooks apart and runs them first on
both dispatchers, before the body is parsed (a cross-site POST with a broken JSON
body is a 403, not a 400). A native static root leaves the route map while hooks
are registered so its responses get the headers too. Upstream's own
`integration/security` and `integration/cookies` e2e specs run against the
adapter (`bun run test:upstream-e2e`) — 116 cases, one documented divergence.

**Cookies.** A repeated cookie name keeps its first value, as `cookie.parse`
(cookie-parser, and Nest's own parser) does; it used to keep the last.

**MEDIA_TYPE versioning.** The version is found in any media range and any
parameter of `Accept` (`application/json;q=0.9;v=2`,
`text/html, application/json;v=2`), mirroring upstream's fix for express and
fastify. It used to read only the first parameter of the whole header.

**Backpressure.** `res.write()` enqueued into an unbounded stream and always
returned `true`, so a slow client made the whole body pile up in memory. On
Bun ≥ 1.4 it now returns `false` once 64 KiB are queued and emits `'drain'` when
Bun has pulled the queue down; write callbacks run asynchronously, as in Node.
A client that leaves mid-stream now emits `'close'` on the response and sets
`destroyed`. The `nodeReadableToWeb` fallback pauses its source the same way.

**WebSocket tuning.** `new BunHttpAdapter({ websocket })` (gateways on the HTTP
port) and `new BunWsAdapter(app, { websocket })` (gateways on their own port)
forward `perMessageDeflate`, `maxPayloadLength`, `backpressureLimit`,
`closeOnBackpressureLimit`, `idleTimeout`, `sendPings` and `publishToSelf` to
`Bun.serve`. Bun's `drain` callback is forwarded as a `'drain'` event on the
client, and `client.send()` returns Bun's status instead of `undefined`.
