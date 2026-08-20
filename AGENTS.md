# AGENTS.md — @trishchuk/bun-nestjs-adapter

> Reference for AI coding agents working on this repository. All facts below are derived from the actual project files — do not assume generic NestJS or Bun conventions apply verbatim.

---

## Project overview

This is a **native Bun HTTP & WebSocket adapter for NestJS**, published on npm as `@trishchuk/bun-nestjs-adapter`. It implements Nest's `AbstractHttpAdapter` and `AbstractWsAdapter` end-to-end on top of `Bun.serve()` (the Web-Fetch API surface) instead of `node:http`.

Key capabilities:
- Full HTTP verb support, JSON/urlencoded/text body parsing, multi-match dispatch, versioning (URI / HEADER / MEDIA_TYPE / CUSTOM), CORS.
- Static assets via `Bun.file()`.
- Streaming (`StreamableFile`, Node `Readable` → Web `ReadableStream`).
- Server-Sent Events (`@Sse()`).
- File uploads via `BunFileInterceptor`, `BunFilesInterceptor`, `BunAnyFilesInterceptor` using native `Request.formData()`.
- WebSocket via `BunWsAdapter` with Bun's native pub/sub (`subscribe` / `unsubscribe` / `publish`).

Runtime requirement: **Bun ≥ 1.3.0** (engines field says `>=1.3.0`; CI pins `1.4.0`).

---

## Technology stack

| Layer | Tool |
|-------|------|
| Runtime | Bun (native `Bun.serve`, `bun:test`, `bun install`) |
| Language | TypeScript 5.x (`target: ES2022`, `module: Preserve`, `moduleResolution: bundler`) |
| Framework integration | NestJS 10.x / 11.x peer dependencies (`@nestjs/common`, `@nestjs/core`, `@nestjs/websockets`) |
| Bundler | `tsup` (ESM + CJS, declaration maps, source maps) |
| Linter / Formatter | `biome` (v1.9.4) — NOT ESLint/Prettier |
| Testing | `bun:test` (native Bun test runner) |
| Benchmarking | Orchestrators in `tests/bench/`; **all load (REST + GraphQL) via external `k6`** (Go) to avoid the co-located bun-`fetch` client bias |
| Versioning / Release | `changesets` + GitHub Actions |
| Git hooks | `husky` + `lint-staged` + `commitlint` |
| Security | Socket.dev, Snyk, CodeQL, `bun audit` |

---

## Repository layout

```
src/                          # Published source
  adapters/
    bun-http-adapter.ts       # ~750 LOC — BunHttpAdapter class (dispatch orchestration only)
    bun-ws-adapter.ts         # ~400 LOC — WebSocket adapter
    index.ts                  # Re-exports both adapters
  http/                       # HTTP building blocks used by BunHttpAdapter
    types.ts                  # BunRequest/BunResponse/Ws*Shim interfaces, shared empty maps
    router.ts                 # BunRouterInstance, compilePath, toBunRoutePath
    server.ts                 # BunHttpServer (Bun.serve wrapper, TLS, unix sockets, native routes)
    request.ts                # request-shim builders, buildHeaders, parseQuery, shared body parser
    response.ts               # makeBunResponse, writable/SSE shim, toResponseInit
    cookies.ts                # parse/sign/unsign cookies
    cors.ts                   # CorsOptions + applyCorsHeaders
    versioning.ts             # applyVersionFilter (HEADER/MEDIA_TYPE/CUSTOM)
    views.ts                  # renderTemplate (ejs/hbs/pug, lazy imports)
    optional-engines.d.ts     # minimal types for untyped optional peers (ejs, pug)
    static.ts                 # matchStatic/serveStatic + serveNativeStatic, MIME map
    streaming.ts              # Node Readable → web stream helpers, duck-type guards
  interceptors/
    bun-file-interceptor.ts   # ~160 LOC — file upload interceptors
    index.ts                  # Re-exports interceptors
  index.ts                    # Package entrypoint — exports adapters + interceptors

tests/
  preload.ts                  # reflect-metadata + Mocha→Bun shim (before/after)
  tsconfig.json               # Extends root tsconfig, rootDir: ".."
  integration/                # E2E specs using bun:test + native fetch()
    bun-adapter.spec.ts       # Core adapter behaviour (routing, headers, body, params, query)
    static-assets.spec.ts     # useStaticAssets()
    static-native.spec.ts     # useStaticAssets({ native: true }), both dispatchers
    streaming.spec.ts         # StreamableFile / Readable streaming
    uploads.spec.ts           # Multipart file upload interceptors
    websocket.spec.ts         # BunWsAdapter gateway tests
    upstream-fixtures.spec.ts # Compatibility suite against upstream nestjs/nest fixtures
    audit-fixes.spec.ts       # Regression / audit tests
    refactor-fixes.spec.ts    # Regression tests for src/http decomposition fixes
    https.spec.ts             # httpsOptions → Bun.serve TLS (self-signed cert in fixtures/own/tls)
    fixtures/own/             # Local Nest AppModules for integration tests
      app.module.ts
      cats/
      streaming/
      uploads/
      ws/
  bench/
    bun-bench.ts              # Single-adapter HTTP bench orchestrator
    run-matrix.ts             # Runs graphql + rest × {small,medium,large} × N runs → writes BENCHMARK.md
    graphql-bench-k6.ts       # GraphQL cross-adapter runner (external k6 load — used by the matrix)
    graphql-k6.js             # k6 load script for GraphQL: mix + per-op metrics + handleSummary JSON
    rest-bench-k6.ts          # REST cross-adapter runner (external k6 load — used by the matrix)
    rest-k6.js                # k6 load script for REST: mix + per-op metrics + handleSummary JSON
    graphql-bench.ts          # GraphQL runner, in-process Bun fetch — bun-vs-bun A/B only
    rest-bench.ts             # REST runner, in-process Bun fetch — bun-vs-bun A/B only
    frameworks/               # Bench targets (one process each, spawned on $PORT)
      bun.ts / express.ts / fastify.ts          # Bare HTTP targets
      nest-{bun,express,fastify}.ts             # Nest HTTP targets
      graphql-nest-{bun,express,fastify}.ts     # GraphQL (@nestjs/apollo) targets
      graphql-nest-bun-yoga.ts                  # GraphQL Yoga driver on bun (experimental, selectable)
      rest-nest-{bun,express,fastify}.ts        # REST (@Controller) targets
      graphql/                                  # Shared DTO / service / resolver / module / bootstrap
                                                #   + bun-yoga-driver.ts (experimental BunYogaDriver)
      rest/                                     # Shared REST controller + module (payload-projected to mirror GraphQL)
      nest/                                     # Shared app.module / app.controller

dist/                         # Build output (tsup — ESM, CJS, .d.ts, sourcemaps)

fixtures/
  nestjs-nest/                # Git submodule — upstream nestjs/nest repository

scripts/
  fixtures-install.sh         # Clone submodule + npm ci + build upstream packages
  fixtures-update.sh          # Bump submodule to origin/master
```

---

## Build and test commands

All commands assume `bun install` has been run.

```bash
# Development
bun run dev              # tsup --watch
bun run typecheck        # tsc --noEmit (uses root tsconfig.json)

# Build
bun run build            # tsup → dist/{index.js, index.cjs, index.d.ts, .map}

# Testing
bun run test             # bun test --preload ./tests/preload.ts tests/
bun run test:integration # bun test --preload ./tests/preload.ts tests/integration/
bun run test:fixtures    # upstream compatibility suite (requires fixtures:install first)

# Benchmarks
bun run bench            # single-adapter HTTP: 30 s × 50 connections
bun run bench:quick      # single-adapter HTTP: 5 s × 50 connections
bun run bench:rest       # REST cross-adapter via k6 (rest-bench-k6.ts); requires k6 on PATH
bun run bench:matrix     # full GraphQL+REST matrix → regenerates BENCHMARK.md
# bench:rest / bench:matrix need k6 (macOS: `brew install k6`)

# Lint / Format
bun run lint             # biome check src tests
bun run lint:fix         # biome check --write src tests
bun run format           # biome format --write src tests

# Fixtures (upstream nestjs/nest compatibility)
bun run fixtures:install # one-time setup: clone submodule + build
bun run fixtures:update  # bump submodule to latest origin/master

# Release
bun run version          # changeset version
bun run release          # changeset publish
bun run prepublishOnly   # typecheck + test + build (runs automatically before npm publish)
```

---

## Code style guidelines

This project uses **Biome** (not ESLint/Prettier). Configuration lives in `biome.json`.

- **Indent**: 2 spaces (`indentStyle: space`, `indentWidth: 2`)
- **Line width**: 90 characters (`lineWidth: 90`)
- **Line ending**: LF (`lineEnding: lf`)
- **Quotes**: single (`quoteStyle: single`)
- **Trailing commas**: always (`trailingCommas: all`)
- **Semicolons**: always (`semicolons: always`)
- **Arrow parens**: as needed (`arrowParentheses: asNeeded`)

Important Biome rule overrides:
- `noExplicitAny: off` — `any` is allowed.
- `useImportType: off` — do not require `import type`.
- `noNonNullAssertion: off` — `!` postfix is allowed.
- `noUnusedVariables: warn` — warns but does not error.
- `noUnusedImports: warn` — warns but does not error.
- `unsafeParameterDecoratorsEnabled: true` — required for NestJS decorators.

TypeScript compiler settings to keep in mind:
- `experimentalDecorators: true` and `emitDecoratorMetadata: true` are **required** for NestJS DI.
- `strict: true` with `noImplicitAny: false` and `strictPropertyInitialization: false`.
- `isolatedModules: true` — each file must be compilable independently.

---

## Testing instructions

### Test runner
Tests use **Bun's native test runner** (`bun:test`). The preload file (`tests/preload.ts`) is automatically loaded because `bunfig.toml` declares:
```toml
[test]
preload = ["./tests/preload.ts"]
```

The preload:
1. Imports `reflect-metadata` (required for Nest decorators).
2. Shims Mocha's `before` / `after` onto `beforeAll` / `afterAll` so upstream fixture specs run unmodified.

### Integration tests (`tests/integration/`)
- Boot a real Nest application with `BunHttpAdapter`, listen on an ephemeral port, and exercise it via native `fetch()`.
- Each spec typically has a `fixtures/own/` AppModule.
- Prefer `fetch()` over supertest/axios because Bun's `fetch()` is native and avoids Node HTTP client bias.

### Upstream fixture tests (`tests/integration/upstream-fixtures.spec.ts`)
- These load AppModules from the `fixtures/nestjs-nest/` git submodule and boot them with `BunHttpAdapter`.
- Requires `bun run fixtures:install` first (clones submodule, runs `npm ci --legacy-peer-deps`, builds upstream packages).
- Some fixture areas are intentionally skipped (see `KNOWN-LIMITATIONS.md`).

### Coverage
CI runs with `--coverage --coverage-reporter=lcov --coverage-dir=coverage` and uploads to Codecov. Coverage targets: project 80%, patch 70%.

---

## Benchmarking

`tests/bench/run-matrix.ts` runs the same NestJS app (`TodoItemService` + CASL `AccessGuard` + global `ValidationPipe`) over **GraphQL** and **REST** on the bun / express / fastify adapters, across {small, medium, large} load sizes × N runs, and regenerates `BENCHMARK.md`.

Things an agent must know before touching the bench:

- **All load is generated by external `k6`, never the in-process Bun `fetch` client.** A single-threaded bun-`fetch` generator co-located with a Bun server contends for the same JSC runtime/cores and *systematically under-reports the bun target* (node-based express/fastify don't share the runtime, so they aren't penalised). k6 (separate Go process) removes that bias. For REST this *flips* the result — with k6 bun wins at every size and the "decline under load" artifact disappears. For GraphQL the effect is within noise (per-request server work is ~3–4× REST, so client contention is a small fraction — measured ~equal under k6 and in-process), but k6 is used for both to keep one instrument and no asymmetry. The matrix wires both protocols → `*-bench-k6.ts` (`BENCH_FILE`). The in-process `graphql-bench.ts` / `rest-bench.ts` are kept **only** for bun-vs-bun A/B, where both sides share the same client slot.
- **REST↔GraphQL payloads are byte-parity by design.** Each REST endpoint projects its response to the exact field set the matching GraphQL query selects — including stringifying `@IDField(() => ID)` fields (GraphQL `ID` scalar), emitting selected-but-null fields, and resolving `assignee` only where the selection asks (NOT on merge). Verified byte-identical per op modulo GraphQL's `{"data":{…}}` envelope. The canonical selections live in `graphql-bench.ts` and are mirrored in `graphql-k6.js`; if you change one, update the other **and** the matching projection in `tests/bench/frameworks/rest/todo-item.controller.ts`.
- **Yoga (experimental):** `graphql-nest-bun-yoga` runs GraphQL Yoga on bun via `tests/bench/frameworks/graphql/bun-yoga-driver.ts` (stock `YogaDriver` only supports express/fastify). Selectable via `--only` on either GraphQL runner; excluded from the default matrix. **+54–58% RPS over Apollo-on-bun** with ~36–40% lower p99 at comparable RSS, measured 2026-08-20 on Bun 1.4.0 (`BENCHMARK-yoga-1.4.0.md`); it was ~38–51% on 1.3.5.
- **Server RSS** is sampled via `ps -o rss=` against the spawned target child during the measurement window only; k6 only drives traffic.
- Each target spawns on `$PORT`; runners call `ensurePortFree()` (kill occupant + wait for the listen socket to free) before every spawn so a slow teardown under load can't poison later runs.
- k6 is required for `bench:rest` / `bench:matrix` (`brew install k6`); `bun-bench.ts` does not need it. Numbers swing ±5–10% on M-series Macs (thermal) — always re-measure on target hardware.

---

## Critical configuration details

### `tsconfig.json` paths redirect
The root `tsconfig.json` contains a **mandatory** `paths` block that redirects every `@nestjs/*` import to `./fixtures/nestjs-nest/node_modules/@nestjs/*`. This is not optional tooling sugar — it prevents runtime DI failures caused by two copies of Nest (root `node_modules` vs. submodule `node_modules`).

> **Do not remove or modify these paths unless you fully understand the duplicate-Symbol / duplicate-class problem.**

### `tsup.config.ts` externals
`@nestjs/*`, `rxjs`, `tslib`, `bun`, and `node:*` modules are listed as `external` so they are not bundled into `dist/`. Published packages resolve them through the consumer's `node_modules` at runtime.

---

## Commit and release conventions

### Commits
Conventional Commits enforced by `commitlint` via Husky. Subject case is unrestricted; header max length is 100 chars.

Examples:
```
feat(adapter): support shared-port websocket upgrade
fix(file-interceptor): skip body parser for multipart payloads
perf(adapter): drop Headers proxy in favour of eager copy
```

### Pre-commit hook
- `.husky/pre-commit` runs `bun x lint-staged`
- `lint-staged` runs `biome check --write --no-errors-on-unmatched` on `*.{ts,js,json}`
- `.husky/commit-msg` runs `bun x commitlint --edit "$1"`

### Release workflow
1. Contributors run `bun x changeset` to describe changes.
2. Pushing to `main` triggers the Release workflow (`.github/workflows/release.yml`).
3. `changesets/action` opens a "version packages" PR.
4. Merging that PR publishes to npm with provenance.

---

## CI / CD pipelines

### CI (`.github/workflows/ci.yml`)
Runs on push/PR to `main`:
1. **Lint + Typecheck** — `bun run lint`, `bun run typecheck`
2. **Build** — `bun run build` + upload `dist/` artifact
3. **Test (own integration suite)** — `bun test --preload ... --coverage` + Codecov upload
4. **Compatibility (upstream fixtures)** — `fixtures-install.sh` + `bun run test:fixtures`
5. **Bench smoke** — `bun run bench:quick`

Bun version pinned to `1.4.0` across all jobs.

### Security (`.github/workflows/security.yml`)
Runs on push/PR to `main` + weekly schedule:
1. **Socket.dev** — supply-chain scan (skipped if `SOCKET_SECURITY_API_KEY` absent)
2. **Snyk** — vulnerability scan with SARIF upload to GitHub Security (continue-on-error, skipped if `SNYK_TOKEN` absent)
3. **bun audit** — always-on baseline (`--audit-level=high`, warn-only)
4. **CodeQL** — JavaScript/TypeScript analysis with `security-and-quality` queries

### Release (`.github/workflows/release.yml`)
Runs on push to `main`. Uses `changesets/action` with `NPM_TOKEN` and `NPM_CONFIG_PROVENANCE: true`.

---

## Dispatcher selection (which requests skip Bun's native matcher)

`BunHttpAdapter.listen()` builds a `Bun.serve({ routes })` map only when no
middleware, classic static-asset mount or `enableCors()` is registered. A mount
opted into `useStaticAssets(root, { native: true })` (Bun >= 1.4.0) is exempt:
it becomes a `{ dir }` entry *in* the map, so it no longer disables the fast
path. Its semantics differ from the classic mount — routes match first, a miss
is a hard 404, any method serves the file — and the manual dispatcher mirrors
them in `serveNativeStatic()` so both paths agree; see `docs/http.md`. On top of that
whole-app switch, individual **paths** are left out of the native map when Bun's
matcher can't destructure them faithfully — `bunRoutesLoseParams()` in
`http/router.ts`. Bun then falls through to the `fetch` callback, which routes
them through `compilePath`'s regex, so both dispatchers produce identical params.

Verified against Bun 1.3.5 and re-verified on 1.4.0, these forms are excluded:

| Path form | What Bun's matcher does |
|---|---|
| `*name`, `{*name}` | matches, but `params` comes back empty — capture lost |
| `:id?` | not optional; param lands under the key `id?` |
| `:id(\d+)` | pattern not enforced (`/p/abc` matches); key is `id(\d+)` |
| `:a-:b` | collapses to a single key `b` holding the whole segment |

Plain `:param` and bare `*` stay native. When touching `compilePath`, re-check
this predicate: a form our regex supports but Bun mis-parses must be listed here
or the two paths silently disagree.

`HEAD` is served from the `GET` handler on both dispatchers when no explicit
`@Head()` route exists. Bun strips the body itself; `makeBunResponse` additionally
refuses to open a `ReadableStream` for a HEAD request and emits `'close'` on the
request instead, so a `@Sse()` route reached over HEAD tears its subscription down
rather than producing into a buffer nobody drains.

---

## Security considerations

- **No bundled NestJS**: `@nestjs/*` are peer dependencies and externals. Vulnerabilities in Nest core are the consumer's responsibility to patch.
- **`req.ip` and proxies**: `req.ip` comes from Bun's `server.requestIP()`. `X-Forwarded-For` is **ignored by default** — it is client-supplied, so honouring it unconditionally lets any caller forge the key rate limiters and audit logs are built on. Apps behind a trusted proxy opt in with `BunHttpAdapter#setTrustProxy()` (the equivalent of Express' `app.set('trust proxy', true)`).
- **Supply-chain monitoring**: CI runs Socket.dev and Snyk scans on every PR.
- **npm provenance**: Releases publish with npm provenance enabled.
- **Audit baseline**: `bun audit --audit-level=high` runs in CI but does not block merges (warn-only).

---

## Known limitations

See `KNOWN-LIMITATIONS.md` for the authoritative list. Summaries:

1. **Bun TDZ on circular imports** (`inspector` / `circular-modules` fixture skipped) — Pure Bun runtime behaviour, unrelated to this adapter. Re-verified 2026-08-20 on the released Bun 1.4.0: still broken, as on 1.3.5, 1.3.14 and 1.4.0-canary (2026-07-26).
2. **Silently inactive fixture blocks** (`global-prefix`, `auto-mock`, `module-utils`) — the submodule moved these fixtures' entry points, and `skipIfMissing()` renders a stale path as a green skip rather than a failure.

Retracted: `lazy-modules` and `scopes` were listed here as adapter/runtime bugs. Both were faulty test setup on our side and now run unskipped — see `KNOWN-LIMITATIONS.md`. Treat any skip whose cause was inferred rather than measured as unknown until re-tested.

When fixing any of these, drop `.skip` from the relevant `describe.skip` in `upstream-fixtures.spec.ts`, run `bun run test:fixtures`, and commit only when zero failures.

---

## Where to make changes

| Task | File(s) |
|------|---------|
| HTTP dispatch, versioning, CORS, static assets, views | `src/adapters/bun-http-adapter.ts` |
| Request/response shims, router, cookies, body parsing, Bun.serve wrapper | `src/http/*.ts` |
| WebSocket gateway behaviour, pub/sub | `src/adapters/bun-ws-adapter.ts` |
| File upload interceptors | `src/interceptors/bun-file-interceptor.ts` |
| Public API surface | `src/index.ts`, `src/adapters/index.ts`, `src/interceptors/index.ts` |
| Integration / E2E tests | `tests/integration/*.spec.ts` + `tests/integration/fixtures/own/` |
| Upstream compatibility tests | `tests/integration/upstream-fixtures.spec.ts` |
| Benchmark targets | `tests/bench/frameworks/` (HTTP, `graphql-nest-*`, `rest-nest-*`, shared `graphql/` + `rest/`) |
| Benchmark runners / matrix | `tests/bench/run-matrix.ts`; `graphql-bench-k6.ts`+`graphql-k6.js`, `rest-bench-k6.ts`+`rest-k6.js` (k6, used by matrix); `graphql-bench.ts`/`rest-bench.ts` (in-process, A/B only) |
| REST↔GraphQL payload parity | `tests/bench/frameworks/rest/todo-item.controller.ts` (mirror `graphql-bench.ts` / `graphql-k6.js` selections) |
| Experimental Yoga driver | `tests/bench/frameworks/graphql/bun-yoga-driver.ts` + `graphql-nest-bun-yoga.ts` target |
| Build config | `tsup.config.ts` |
| TypeScript config | `tsconfig.json` (exercise extreme caution with `paths`) |
| Lint/format rules | `biome.json` |
| CI | `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/workflows/security.yml` |
