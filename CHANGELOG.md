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

- 5834eb4: Fix the published types under NestJS 12. `@nestjs/common` gained an `exports` map in v12 where `./*` resolves to `./*.js`, so the bare `@nestjs/common/interfaces` directory import no longer resolves — only `interfaces/index.js` exists on disk. `dist/index.d.ts` carried that specifier, so consumers on v12 got `TS2307`. Both import sites now name the concrete interface file, which resolves on 10, 11 and 12 alike.

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
