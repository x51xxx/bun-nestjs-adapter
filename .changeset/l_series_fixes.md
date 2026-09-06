---
'@trishchuk/bun-nestjs-adapter': patch
---

Nine small fixes from the L-series of the 2026-09-06 audit.

- **Several params in one path segment** now work: `@Get('x/:a-:b')` and
  `@Get('v:major.:minor')` used to match the literal text instead of capturing.
  Groups are greedy, as path-to-regexp makes them.
- **`res.cookie(name, value, { maxAge })`** emits `Expires` alongside `Max-Age`,
  and `maxAge` overrides an explicit `expires` — both as Express does.
- **`enableCors()` after `listen()`** now takes effect instead of being a silent
  no-op on a server already serving from the native route map.
- **A urlencoded body with duplicate keys** gives an array: `a=1&a=2` is
  `['1','2']`, matching the query-string parser and Express.
- **`req.hostname`** handles an IPv6 `Host` header — `[::1]:1234` yields
  `[::1]`, where it used to yield `[`.
- **`app.close()`** waits for `Bun.serve`'s `stop()` to drain in-flight requests
  instead of dropping the promise and returning immediately.
- **A handler error on the native-routes path** goes through the handler
  registered with `setErrorHandler()`, as it already did on the manual
  dispatcher; and `next(err)` from such a handler is no longer swallowed into a
  404.
- **An abnormally closed WebSocket** raises `'error'` on the client and the
  server. Bun exposes no `error` callback, so this is derived from a close code
  outside 1000/1001/1005 — previously nothing could ever emit that event.
- Dead code removed: `CompiledRoute.isMiddleware`, the unreachable `'USE'`
  branch in route matching, and `ServerEntry.serverEmitter`.
- **Route matching on the manual dispatcher** keeps a bucket per HTTP verb
  instead of testing every compiled route in the application against every
  request — about a third faster on a 201-route app.
- **`@All()` and `@Get()` on the same path** now run in the order they were
  declared on the native-routes path too. It ran every method-specific handler
  before every `@All()` one, disagreeing with the manual dispatcher.
