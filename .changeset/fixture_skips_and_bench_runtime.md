---
'@trishchuk/bun-nestjs-adapter': patch
---

Un-skip two upstream fixtures that were never broken, and make the benchmark harness follow its own runtime.

**`scopes` and `lazy-modules` retracted as known limitations.** Both were skipped
with causes that had been inferred, not measured, and both were wrong:

* `scopes` was documented as "Bun drops `design:paramtypes` for request-scoped
  providers". The assertion read `HelloService.COUNTER` — a counter that class
  does not have and never increments, so it could only ever be 0. Upstream asserts
  on `UsersService`. With the correct assertions, controller, service, pipe,
  interceptor and guard all resolve 3/3 per request.
* `lazy-modules` was documented as "routes frozen at `listen()` by the native
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
