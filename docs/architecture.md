# Architecture

Internals worth knowing before changing the adapter. Source:
`src/adapters/bun-http-adapter.ts` (~1.6k LOC), `src/adapters/bun-ws-adapter.ts`,
`src/interceptors/bun-file-interceptor.ts`.

## Two HTTP dispatch paths

Chosen in `BunHttpAdapter.listen()`:

- **Fast path** — when there's no adapter-level `use()` middleware, static-asset
  mount, or CORS, the route table is compiled into a `Bun.serve({ routes })` map
  (`buildBunRoutes()`) and matched by Bun's native C++ router. Route handlers
  (`runBunRouteSingle` / `runBunRouteChain`) run with minimal per-request
  allocation.
- **Slow path** — any middleware/static/CORS forces the manual `fetch`
  dispatcher (`handle()`), which does its own regex matching and `next()`-style
  chaining.

**Consequence:** the fast path freezes the route map at boot. The adapter
mitigates this by rebuilding and calling `server.reload({ routes })` whenever a
route or middleware is registered after `listen()` (`reloadRoutes()`); if
middleware/CORS/static appears, `reload()` switches the server to the `fetch`
dispatcher. Dynamic-route edge cases are tracked in
[`KNOWN-LIMITATIONS.md`](../KNOWN-LIMITATIONS.md).

## Request / response are shims, not Node objects

`bunReqToShim()` turns a Web `Request` into an Express-flavoured `req`
(`params`, `query`, `headers`, an `EventEmitter` bridging `AbortSignal` →
`'close'`). The untouched Web `Request` is kept as `req.bunRequest` — used by the
upload interceptors and by the GraphQL Yoga driver.

`makeBunResponse()` builds a `res` that **buffers**: it settles a single
`Promise<Response>` (via an internal `_resolve`) instead of writing to a socket.
`attachWritableShim()` lazily upgrades the response to a streaming
`ReadableStream` the first time `write()`/`writeHead()` is called (SSE,
`StreamableFile`, `Readable`). When editing `reply()`/`end()`, preserve the
"buffered until streamed" contract and the `if (response.finished) return`
guards.

The JSON reply path uses Bun's native `Response.json(value, init)` — it
serialises straight to bytes, skipping a `JSON.stringify` string allocation.

## WebSocket upgrade

There is no Node `'upgrade'` event to hook — in Bun, `server.upgrade()` must be
called from inside the `fetch`/`routes` handler of the same `Bun.serve` that
owns the `websocket` block. So shared-port gateways register their path in
`BunHttpAdapter.wsPaths`, and the HTTP dispatcher performs the upgrade
(`server.upgrade(req, { data })`) when an `Upgrade: websocket` request matches a
registered (normalised) path. Standalone gateways (explicit non-HTTP port) run
their own `Bun.serve`. See [WebSockets](./websockets.md).

> `bun-http-adapter.ts` must **not** import from `bun-ws-adapter.ts`: the WS
> adapter imports `@nestjs/websockets`, an *optional* peer dependency, so pulling
> it into the HTTP path would break HTTP-only consumers. Small helpers are
> duplicated instead.

## The `tsconfig.json` paths redirect (contributors)

`tsconfig.json` redirects every `@nestjs/*` import to
`./fixtures/nestjs-nest/node_modules/@nestjs/*` so the adapter sources, our
tests, and the upstream fixture AppModules all resolve through **one** copy of
Nest. This prevents duplicate-class / duplicate-`Symbol` DI failures. Do not
remove it without understanding that failure mode.

## Build & externals

`tsup` emits ESM + CJS + `.d.ts`. `@nestjs/*`, `rxjs`, `tslib`, `bun`, and
`node:*` are marked external — never bundled into `dist/`; consumers resolve
them at runtime.
