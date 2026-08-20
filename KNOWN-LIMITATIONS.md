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

## Retracted — `lazy-modules` and `scopes` were never adapter or runtime bugs

Both were re-tested on 2026-07-26 against Bun 1.3.5, 1.3.14 and 1.4.0-canary, and
again on 2026-08-20 against the released Bun 1.4.0. They pass on all four. The
skips were caused by faulty test setup on our side, not by Bun or the adapter —
the previous entries here described causes that were never verified.

**`lazy-modules`** was documented as "routes frozen at `listen()`". It wasn't:
our block booted `AppModule`, which imports `GlobalModule` + `EagerModule` and
lazily loads a *provider-only* module. It never references `LazyController`, so
`/lazy/*` was never registered with any adapter and the 404 was correct. Upstream's
own `e2e/lazy-import-*-providers.spec.ts` bootstraps `controllers:
[LazyController]` directly; the lazy loading happens *inside* the handler, which
is an ordinary route as far as the adapter is concerned. Instrumenting
`registerRoute` confirmed zero route registrations, before or after `listen()`.

**`scopes`** was documented as "Bun drops `design:paramtypes` for request-scoped
providers". It doesn't: the assertion read `HelloService.COUNTER`, and that class
has no `COUNTER` and never increments one — it could only ever be 0. Upstream's
`e2e/request-scope.spec.ts` asserts on `UsersService` instead. With the correct
assertions, controller, service, pipe, interceptor and guard all resolve 3/3 per
request with `REQUEST_SCOPED_DATA === [1, 1, 1]`.

Both blocks now run unskipped in `upstream-fixtures.spec.ts`.

**Lesson for the remaining entries below:** a skipped fixture whose cause was
inferred rather than measured is not a known limitation, it is an unknown. Verify
before documenting.

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

**Re-verified 2026-08-20** on the released Bun 1.4.0 — still throws, as it does on
1.3.5, 1.3.14 and 1.4.0-canary (checked 2026-07-26). This is the only fixture
skip with a measured cause.

## Fixture blocks silently inactive after an upstream layout change

**Affects:** `global-prefix`, `auto-mock`, `module-utils`.

**Symptom:** none — and that is the problem. `skipIfMissing()` turns a fixture
path that no longer exists into a green `describe.skip`, so a fixture that moved
upstream looks identical to one that passes.

**Cause:** the `fixtures/nestjs-nest` submodule has drifted from the paths the
spec hard-codes. `global-prefix` no longer ships a `src/` at all; `auto-mock` has
`src/*.service.ts` but no `app.module.ts`; `module-utils` renamed its entry point
to `src/integration.module.ts`.

**Unblocks when** the spec points at the current entry points, and
`skipIfMissing` distinguishes "submodule not installed" (legitimate skip) from
"installed but this path is gone" (should fail loudly).

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
