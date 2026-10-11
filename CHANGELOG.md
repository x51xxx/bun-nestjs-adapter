# @trishchuk/bun-nestjs-adapter

## 0.3.0

### Minor Changes

- 2672ea6: Guarantee every request settles, fix SSE on the fallback dispatcher, and unify the request shim.

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

- 44c1282: Nest 12.1 support, response backpressure, and WebSocket tuning.

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

- caadda3: Classic `useStaticAssets()` mounts now send cache validators and answer conditional requests.

  A classic mount replied `200` with the whole file every time: no `ETag`, no
  `Last-Modified`, so a browser could never revalidate — `@nestjs/platform-express`
  has done both by default for years through `serve-static`. `serveStatic()` now
  emits a weak `ETag` and `Last-Modified` and answers `304` (empty body) to a
  matching `If-None-Match` or `If-Modified-Since`.

  The `ETag` uses the same formula as Bun's native `{ dir }` route, so the classic
  and `native: true` modes hand out byte-identical validators for the same file —
  switching a mount from one to the other does not invalidate what clients already
  cached. That equality is asserted in `tests/integration/static-assets.spec.ts`.

  A 304 from a native mount keeps `content-type` (that is what Bun's own dir route
  does) while a classic one drops it, as `serve-static` does; each mode is
  identical across both dispatchers, which is the property the tests pin.

  `Range` needed no work: from Bun 1.4.0 a `Bun.file` body answers `206` on its
  own, rewriting the `content-length` we set. Both are now covered by tests, the
  `206` one gated on the runtime version.

- caadda3: Raise the `engines.bun` floor from `>=1.2.0` to `>=1.3.0`.

  The `1.2.0` floor was never exercised — CI has pinned 1.3.x and now 1.4.0, and
  the README badge has advertised "Bun 1.3+" the whole time. The field now says
  what the project actually supports, and the badge, `AGENTS.md`, `docs/` and the
  bug-report template agree with it.

  Unrelated to `useStaticAssets({ native: true })`, which keeps its own runtime
  check and falls back to the classic mount below Bun 1.4.0.

- a3f8d80: JSON body parsing now matches `body-parser`, which is what
  `@nestjs/platform-express` runs. Every case below was read off a real
  platform-express app before it was implemented.

  **An empty JSON payload is `{}`.** It used to be `undefined`, which quietly
  broke a `ValidationPipe` over a DTO whose fields are all optional — `{}`
  validates, `undefined` does not. Covers all three shapes an empty payload
  arrives in: `Content-Length: 0`, no body at all, and a chunked stream that
  closes immediately. Each request gets its own object.

  **A bare JSON scalar is rejected with 400.** `body-parser` runs with
  `strict: true` by default: only an object or an array is a valid top-level JSON
  body, so `null`, `123`, `true`, `"str"` and a whitespace-only payload are
  answered with `400 Bad Request` rather than handed to the handler.

  **This is a behaviour change for anything that posts top-level JSON scalars** —
  they used to be accepted. Use `{ bodyParser: false }` and parse the body
  yourself if you need to keep taking them.

- 30cf2a5: Add `useStaticAssets(root, { native: true })` — serve a static root through Bun 1.4.0's native `{ dir }` route.

  A classic static mount is handled inside the manual `fetch` dispatcher, which
  means registering one drops the **whole app** off the `Bun.serve({ routes })`
  fast path. Bun 1.4.0 added directory routes, so the mount can instead become a
  `{ dir }` entry in the route map. Measured locally with k6 (50 VUs, both
  orders, M-series Mac, a small in-repo JSON fixture served from page cache):
  serving the files goes from ~18.6k to ~35–40k RPS, and ordinary API routes in
  the same app recover ~3% by getting the fast path back. Expect a smaller
  relative gain for large assets, where the transfer dominates.

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

- 9716cef: Support NestJS 12.

  - Widen the `@nestjs/common` / `@nestjs/core` / `@nestjs/websockets` peer range to `^10.0.0 || ^11.0.0 || ^12.0.0`.
  - Fix `@Sse()` routes under Nest 12: `RouterResponseController.sse()` now takes its disconnect source from `request.socket ?? response` and subscribes with `.once('close', …)`, so the request shim's `socket` shares the request's `EventEmitter` instead of being a frozen no-op object. Without this every SSE route 500'd with `disconnectSource.once is not a function`. Nest 12's `@SseSignal()` works as a result.
  - Implement the `query()` adapter method for Nest 12's new QUERY verb. `AbstractHttpAdapter.query()` delegates to `this.instance.query(...)`, which is `undefined` here, so a single `@QueryMethod()` route crashed the whole bootstrap.
  - Keep SEARCH, QUERY and the WebDAV verbs off the native `Bun.serve({ routes })` map. Bun accepts only the seven standard verbs as method keys and throws `ERR_INVALID_ARG_TYPE` for anything else, so a `@Search()` route took the app down at `listen()` whenever it was on the native-routes fast path. Those verbs now fall through to the manual dispatcher while the standard verbs on the same path stay on the fast path.

- efce238: Upload interceptors now reject a file under a field they weren't asked for.

  `BunFileInterceptor('avatar')` used to ignore a file arriving under any other
  field name, so a client could upload under the wrong name, get a `201`, and
  never learn the file had been dropped. Each interceptor now declares which file
  parts it accepts and answers `400 Unexpected field - <name>` for anything
  outside that — matching Multer:

  - `BunFileInterceptor(field)` — one file, under that field only.
  - `BunFilesInterceptor(field, maxCount)` — files under that field only, at most
    `maxCount`.
  - `BunAnyFilesInterceptor()` — everything, as before.

  Text fields are never policed by name, and a request carrying no file at all is
  still fine.

  **This is a behaviour change** for forms that carry file parts the interceptor
  was not asked for: they used to be silently ignored and are now a 400. Use
  `BunAnyFilesInterceptor()` if you want to keep accepting them. Note this also
  means two single-field interceptors can no longer share one route, since each
  rejects the other's field — pair one with `BunAnyFilesInterceptor()` instead.

- 99e459a: Upload limits now guard memory, and the multipart interceptors match Multer's
  error contract.

  **`limits.totalSize` — a real pre-buffer guard.** `Request.formData()`
  materialises every part before it returns, so `fileSize` and `files` could only
  ever be checked once the bytes were already in memory: a 2 GB upload against
  `fileSize: 1_000_000` was buffered in full and only then rejected. `totalSize`
  is compared against `Content-Length` before the body is read, and it defaults to
  `fileSize * <max files> + 1 MiB` whenever `fileSize` is set and the file count
  is known — so existing code gets the protection without changing. Set it
  explicitly to adjust the allowance, or to `Infinity` to opt out. A chunked
  upload carries no `Content-Length` and still cannot be pre-checked.

  **`maxCount` rejects instead of truncating.** `BunFilesInterceptor(field, 3)`
  used to drop the fourth file silently, leaving the client believing it had
  uploaded. It now throws `400 Unexpected field - <field>`, as Multer does.

  **Several interceptors can share one route.** The parsed form is memoised on the
  request, so the second interceptor no longer fails with `Body already used`.

  **Messages match `@nestjs/platform-express`:** `File too large` (413),
  `Too many files` (400), `Unexpected field - <field>` (400).

### Patch Changes

- 6d4d221: Make routing behave identically on both dispatchers: wildcard captures, middleware prefix boundaries, and HEAD.

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

- ea09001: CORS now matches the `cors` package, and classic static mounts decode the path.

  **Preflight handling.** `enableCors()` gained `preflightContinue` and
  `optionsSuccessStatus`, the two options `cors` (which `@nestjs/platform-express`
  uses) exposes for this. Every `OPTIONS` is treated as a preflight and ended with
  `optionsSuccessStatus` — `204` by default — which is what both `cors` and
  `@fastify/cors` do; pass `preflightContinue: true` to apply the preflight
  headers and fall through to routing, so your own `@Options()` handler owns the
  response.

  **Preflight-only headers stay on the preflight.** `Access-Control-Allow-Methods`,
  `Access-Control-Allow-Headers` and `Access-Control-Max-Age` describe a _future_
  request and were going out on every response; they are now emitted only on a
  preflight. `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials` and
  `Access-Control-Expose-Headers` still go on both, matching `cors`.

  **Classic static mounts percent-decode the path.** `/static/my%20file.txt` was a
  404 while the same file served fine through `useStaticAssets(root, { native:
true })` — any asset with a space or a non-ASCII character in its name was
  unreachable. Both modes now share the same per-segment decode, which is also the
  traversal guard: a segment decoding to `.`, `..`, nothing, or hiding a separator
  or `%00` is rejected (`403` classic, `404` native) instead of resolved.

- b70c43c: Un-skip two upstream fixtures that were never broken, and make the benchmark harness follow its own runtime.

  **`scopes` and `lazy-modules` retracted as known limitations.** Both were skipped
  with causes that had been inferred, not measured, and both were wrong:

  - `scopes` was documented as "Bun drops `design:paramtypes` for request-scoped
    providers". The assertion read `HelloService.COUNTER` — a counter that class
    does not have and never increments, so it could only ever be 0. Upstream asserts
    on `UsersService`. With the correct assertions, controller, service, pipe,
    interceptor and guard all resolve 3/3 per request.
  - `lazy-modules` was documented as "routes frozen at `listen()` by the native
    route map". The block booted `AppModule`, which never references
    `LazyController`, so `/lazy/*` was never registered with any adapter —
    instrumenting `registerRoute` showed zero registrations, before or after
    `listen()`. Upstream bootstraps `controllers: [LazyController]`; the lazy load
    happens inside the handler, which is an ordinary route.

  Fixture-suite skips drop from 10 to 3. Verified on Bun 1.3.5, 1.3.14 and
  1.4.0-canary — identical on all three. The remaining `inspector` skip (Bun's TDZ
  on circular imports) is still reproducible on all three and is the only fixture
  skip with a measured cause.

  **Benchmark harness.** The runners spawned target servers with a bare
  `spawn('bun', …)`, resolving from `PATH` rather than the runtime executing the
  harness. Any runtime comparison therefore benchmarked whichever bun happened to be
  installed. Now `process.execPath`.

- d5c5718: Nine small fixes from the L-series of the 2026-09-06 audit.

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
    dispatcher; and `next(err)` from such a handler is no longer swallowed into a 404.
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

- 5834eb4: Fix the published types under NestJS 12. `@nestjs/common` gained an `exports` map in v12 where `./*` resolves to `./*.js`, so the bare `@nestjs/common/interfaces` directory import no longer resolves — only `interfaces/index.js` exists on disk. `dist/index.d.ts` carried that specifier, so consumers on v12 got `TS2307`. Both import sites now name the concrete interface file, which resolves on 10, 11 and 12 alike.
- e151208: Fix two defects found in the 2026-09-06 audit.

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

- 8db8c60: Two more parity fixes from the 2026-09-06 audit, both measured against
  `@nestjs/platform-express` first.

  **Static mounts on one prefix are all consulted.** Only the first root covering
  a path was ever tried, so a second `useStaticAssets(root, { prefix })` on the
  same prefix was dead weight. They now chain in registration order — the first
  one holding the file wins, the next answers what the previous lacks, and route
  dispatch still runs once they all miss — the same behaviour `serve-static` gets
  from `next()`.

  **A malformed JSON body is answered with 400.** The parse error was swallowed
  and the handler ran with `req.body === undefined`, which surfaced later as a
  confusing DTO-validation failure or, on a route without validation, not at all.
  The `SyntaxError` is now wrapped in `BadRequestException` and rendered by Nest's
  error handler, so the response matches platform-express:
  `{"message":…,"error":"Bad Request","statusCode":400}`. `req.rawBody` is still
  populated for the rejected payload, and only `application/json` is policed this
  way.

## 0.2.0

### Minor Changes

- 9b9dc57: HTTPS support and HTTP adapter decomposition.

  - `NestApplicationOptions.httpsOptions` now reaches `Bun.serve({ tls })` via `initHttpServer()`.
  - Split the monolithic `bun-http-adapter.ts` (~1,600 LOC) into focused `src/http/` modules:
    router, server (`Bun.serve` wrapper + TLS), request/response shims, cookies, CORS,
    versioning, views, static assets, streaming, shared types.

- 8b898f4: View engine and cookie support.

  - `setViewEngine()` / `render()` with EJS, Pug, and Handlebars (lazy-loaded optional peers).
  - Cookie parsing on `req.cookies` / `req.signedCookies` and `res.cookie()` / `res.clearCookie()`.

### Patch Changes

- 9b9dc57: Fixes found during the decomposition.

  - `req.url` kept the protocol/host part for root requests with a query string.
  - Malformed percent-encoding in route params or cookies returned 500 instead of being tolerated.
  - A static-asset miss (registered prefix, file not on disk) hard-404ed instead of falling
    through to route dispatch.

## 0.1.0

### Minor Changes

- e6fb0f4: Initial public release of the Bun adapter for NestJS.

  - `BunHttpAdapter` — native `Bun.serve` HTTP adapter with a `Bun.serve({ routes })` fast path.
  - `BunWsAdapter` — WebSocket adapter on top of `Bun.serve({ websocket })` with native pub/sub.
  - `BunFileInterceptor` family for multipart uploads via `Request.formData()`.
  - `StreamableFile` / Node `Readable` streaming and `@Sse()` support.
  - Versioning (URI / HEADER / MEDIA_TYPE / CUSTOM), CORS, static assets.
