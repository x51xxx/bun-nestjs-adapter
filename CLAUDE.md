# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` is the authoritative, detailed reference (stack, full file tree, CI, conventions, benchmarking, known limitations). This file is the fast-start summary — read `AGENTS.md` when you need depth.

## What this is

`@trishchuk/bun-nestjs-adapter` — a native Bun adapter that runs a NestJS app on `Bun.serve()` (Web Fetch API) instead of `node:http`. It implements Nest's `AbstractHttpAdapter` and `AbstractWsAdapter` end-to-end. Published source is only `src/`; everything else is tests, fixtures, and benchmarks.

Runtime: **Bun ≥ 1.2.0** (CI pins 1.4.0). This is a Bun project — use `bun`, not `npm`/`node`.

## Commands

```bash
bun install
bun run typecheck          # tsc --noEmit (root tsconfig.json)
bun run build              # tsup → dist/ (ESM + CJS + .d.ts)
bun run lint               # biome check src tests   (NOT eslint/prettier)
bun run lint:fix           # biome check --write

bun run test               # full bun:test suite (preloads tests/preload.ts)
bun run test:integration   # tests/integration/ only
bun run test:fixtures      # upstream nestjs/nest compat — needs `bun run fixtures:install` first

# single test file / single case:
bun test --preload ./tests/preload.ts tests/integration/streaming.spec.ts
bun test --preload ./tests/preload.ts tests/integration/ -t "partial name"
```

`tests/preload.ts` (loads `reflect-metadata`, shims Mocha `before`/`after`) is auto-applied via `bunfig.toml`'s `[test] preload`, so plain `bun test <file>` works too; the package scripts pass `--preload` explicitly as well.

Benchmarks: `bun run bench` (single-adapter HTTP). `bun run bench:matrix` / `bun run bench:rest` need **k6** on PATH (`brew install k6`) and regenerate `BENCHMARK.md`.

## Architecture — the parts that span multiple files

**Two HTTP dispatch paths, chosen in `BunHttpAdapter.listen()`** (`src/adapters/bun-http-adapter.ts`):
- **Fast path** — when no `use()` middleware, static assets, or CORS are registered, the adapter hands routing to Bun's native C++ matcher via `Bun.serve({ routes })` (`buildBunRoutes()`). Route handlers run with minimal allocation (`runBunRouteSingle` / `runBunRouteChain`).
- **Slow path** — any middleware/static/CORS forces the manual `fetch` dispatcher (`handle()`), which does its own regex route matching and `next()`-style chaining.
- Consequence: the fast path **freezes the route map at boot**, so routes added after `app.listen()` (lazy modules) are invisible. See `KNOWN-LIMITATIONS.md`.
- Individual paths also opt out of the native map when Bun's matcher would mangle their params (`*splat`, `:id?`, `:id(\d+)`, `:a-:b`) — see `bunRoutesLoseParams()` and the dispatcher-selection table in `AGENTS.md`. Bun falls through to `fetch`, so both paths yield identical `req.params`.

**Request/response are shims, not real Node objects.** `bunReqToShim()` turns a Web `Request` into an Express-flavoured `req` (`.params`, `.query`, `.headers`, EventEmitter for `'close'`). `makeBunResponse()` builds a `res` that **buffers** and only settles a `Promise<Response>` via `res._resolve(new Response(...))` — there is no socket write. `attachWritableShim()` lazily upgrades a response to a streaming `ReadableStream` the first time `write`/`writeHead` is called (SSE, `StreamableFile`, Node `Readable`). When editing `reply()`/`end()`, preserve the "buffered until streamed" contract.

**WebSocket** (`src/adapters/bun-ws-adapter.ts`): `BunWsAdapter.create()` picks one of two modes. **Shared-port** (port `0`/undefined, or equal to the HTTP listen port) registers the gateway path in `BunHttpAdapter.wsPaths`, and the HTTP adapter performs the upgrade inside its own dispatcher via `server.upgrade()` (both the native-routes hot path and the manual `fetch` path funnel WS-upgrade requests to one lookup site). **Standalone** (an explicit *different* port) spins up its own `Bun.serve` (`startBunServer`). `BunWsClient`/`BunWsServer` are EventEmitter shims mapping Bun's ws callbacks to the Node-`ws` contract; native pub/sub is exposed via `subscribe`/`publish`.

Important: **`bun-http-adapter.ts` must not import from `bun-ws-adapter.ts`** — the WS adapter imports `@nestjs/websockets` (an *optional* peer dependency), so importing it into the HTTP path would break HTTP-only consumers who haven't installed it. Duplicate the small helper instead (e.g. path normalization for `wsPaths` lookups).

## Non-obvious gotchas

- **`tsconfig.json` `paths` redirect is load-bearing.** Every `@nestjs/*` resolves to `./fixtures/nestjs-nest/node_modules/@nestjs/*` so adapter code, tests, and upstream fixtures share **one** copy of Nest. Removing it reintroduces duplicate-class/duplicate-Symbol DI failures. Don't touch `paths` casually.
- **Biome, not ESLint/Prettier.** `any`, non-null `!`, and missing `import type` are intentionally allowed; line width 90, single quotes, 2-space indent. `experimentalDecorators` + `emitDecoratorMetadata` are required for Nest DI.
- **`@nestjs/*`, `rxjs`, `tslib`, `bun`, `node:*` are externals** in `tsup.config.ts` — never bundled into `dist/`.
- **Bench load is external k6 for both REST and GraphQL, never the in-process Bun `fetch` client.** A bun-`fetch` generator co-located with a Bun server under-reports the bun target (shared JSC runtime/cores); k6 removes the bias (flips REST; within-noise for GraphQL). The matrix uses `*-bench-k6.ts`; `graphql-bench.ts`/`rest-bench.ts` remain for bun-vs-bun A/B only. REST↔GraphQL payloads are byte-identical per op — a GraphQL selection lives in both `graphql-bench.ts` and `graphql-k6.js` and is mirrored in `tests/bench/frameworks/rest/todo-item.controller.ts`; change all three together. Details in `AGENTS.md` → Benchmarking.

## Conventions

Conventional Commits (commitlint via Husky); `lint-staged` runs Biome on commit. When fixing a skipped upstream fixture, drop `.skip` in `upstream-fixtures.spec.ts`, run `bun run test:fixtures`, and commit only at zero failures.
