---
'@trishchuk/bun-nestjs-adapter': minor
---

Guarantee every request settles, fix SSE on the fallback dispatcher, and unify the request shim.

**Hung connections (H1).** The per-request `Promise<Response>` had no single
"settled" flag — completion was inferred from `finished`/`headersSent`, which the
streaming upgrade set inconsistently. Throwing after `res.write()` made `_reject`
resolve an already-settled promise (a silent no-op) and orphan the
`ReadableStream`, so the connection stayed open forever. `makeBunResponse` now
owns a `settle()` helper every exit point routes through, and `_reject` errors the
stream when the response is already streaming. Two related leaks are closed:
`setNotFoundHandler` now receives a real `next` that renders the built-in 404
(it used to get a no-op), and `reply()` after `write()` appends to the stream
instead of dropping the body.

**SSE on the `fetch` dispatcher (H2).** Only the native-routes fast path grafted
the EventEmitter (`on`/`once`/`off`/`emit`) and `socket` shims onto the request,
so Nest's `RouterResponseController.sse()` — which calls `request.on('close', …)`
unconditionally — returned 500 for any app that had middleware, static assets or
CORS registered. Both dispatchers now build the request through one function, so
the Node-isms, the abort→`'close'` bridge and `req.ip` can't drift apart again.

**`req.ip` (breaking behaviour change).** It now comes from Bun's
`server.requestIP()` on both paths instead of being hardcoded to `127.0.0.1` on
the fast path. `X-Forwarded-For` is **no longer trusted by default** — it is
client-supplied, so honouring it unconditionally let any caller forge the key that
rate limiters and audit logs are built on. Apps genuinely behind a proxy must now
opt in with the new `BunHttpAdapter#setTrustProxy()` (the equivalent of Express'
`app.set('trust proxy', true)`).
