# Known limitations

Tracks the fixture areas that are **skipped** in
`tests/integration/upstream-fixtures.spec.ts` and the reason, plus what
would unblock them.

## Update — single-source-of-`@nestjs/*` shipped

`tsconfig.json` now redirects `@nestjs/*` → `./fixtures/nestjs-nest/node_modules/@nestjs/*`,
so our test code, our adapter sources, and the upstream fixture AppModules
all resolve through **the same** copy. That cleared the entire class of
"two copies of Nest, two distinct classes / Symbols" failures:

- **versioning (URI + middleware)** — 10 cases now pass.
- **versioning (HEADER)** — 3 cases now pass.

The remaining skips are narrower issues that the paths-redirect doesn't
address.

## Lazy-loaded routes after `app.listen()`

**Affects:** `lazy-modules`.

**Symptom:** `GET /lazy/transient` and `/lazy/request` return 404.

**Cause:** Our `Bun.serve({ routes })` fast path freezes the route map at
`app.listen()`. `LazyModuleLoader.load()` mutates Nest's route table at
runtime — those new routes never reach the Bun server.

**Unblocks when** the adapter calls `server.reload({ routes: rebuild() })`
after each lazy load, or detects `LazyModuleLoader` in the module graph
at boot and falls back to the manual `fetch` dispatcher (which already
handles dynamic dispatch).

**Update:** the adapter now rebuilds and calls `server.reload({ routes })`
whenever a route / middleware is registered after `listen()` (see
`reloadRoutes()` in `bun-http-adapter.ts`). Whether `LazyModuleLoader.load()`
routes through that registration path for this fixture is untested — re-run
`bun run test:fixtures` with the skip removed to check before assuming it's
still broken.

## Request-scoped service metadata

**Affects:** `scopes`.

**Symptom:** the request-scoped controller resolves and returns 200, but
`HelloService.COUNTER` stays at 0 — the request-scoped service is never
instantiated.

**Cause (suspected):** Bun's per-file transpile of
`@Injectable({ scope: Scope.REQUEST })` drops the `design:paramtypes`
metadata Nest needs to provision a per-request service instance, even
with `emitDecoratorMetadata: true`. Cross-file type references (the
service is imported from a sibling module) make the elision more
aggressive.

**Unblocks when** Bun preserves emitted decorator metadata for cross-file
type imports, or we pre-compile the fixture sources with `tsc` instead of
letting Bun transpile them on demand.

## Bun TDZ on circular imports

**Affects:** `inspector` (the upstream `circular-modules` fixture).

**Symptom:**

```
ReferenceError: Cannot access 'CircularService' before initialization.
```

**Cause:** Bun's per-file transpiler hoists circular `import {…}`
references into a temporal dead zone where Node-via-tsc would not. Pure
Bun runtime behaviour, no relation to our adapter.

**Unblocks when** Bun ships a fix or the upstream fixtures change their
circular layout.

## WebSocket namespaces

**Affects:** any `@WebSocketGateway({ namespace: … })`.

**Symptom:** `BunWsAdapter.create()` throws
`"BunWsAdapter" does not support namespaces. Use socket.io for that.`

**Cause:** namespaces are a socket.io protocol feature, not part of the raw
WebSocket / `Bun.serve` pub-sub model this adapter targets. Path-based routing
(`@WebSocketGateway({ path })`) and Bun-native topics cover the common cases.

**Unblocks when** a socket.io-compatible layer is added — out of scope for a
native-Bun WS adapter.

> **Not a limitation (shipped):** shared-port gateways now work — a
> `@WebSocketGateway()` with no port (or the HTTP port) upgrades on the main
> `Bun.serve` via the HTTP dispatcher. Only an explicit *different* port opens a
> second listener.

## How to verify when re-enabling

Drop `.skip` from the relevant `describe.skip` and run
`bun run test:fixtures`. If 0 fail again, commit the change.
