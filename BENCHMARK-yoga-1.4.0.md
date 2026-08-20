# NestJS Bun Adapter — GraphQL vs REST Benchmark

Generated 2026-08-20 18:15:08 UTC.

## Environment

- **Host**: MacBook-Pro-Taras.local (darwin 25.3.0)  
- **Total RAM**: 48.0 GB  
- **Bun**: 1.4.0  
- **Runs per (size × protocol)**: 5  
- **Protocols**: graphql  
- **Load generator**: both REST and GraphQL driven by external **k6** (Go, multi-threaded) — the same instrument for every target.

## Workload

Same `TodoItemService` (1000 seeded items, 50 users), same DTOs, same CASL `AccessGuard` + `@UseAbility(...)`, same global `ValidationPipe`. The only difference between targets is **how requests are dispatched**:

- `graphql-nest-*` — `@nestjs/apollo` + `@nestjs/graphql` with a hand-written resolver. `assignee` is populated by `@ResolveField`.
- `rest-nest-*` — plain `@Controller` mapping the same operations to REST verbs (GET/POST/PATCH). `assignee` is resolved by an explicit per-row lookup so the response payload mirrors what the GraphQL query selected.

Operation mix per request (weighted, 100-entry table):

| op | weight | GraphQL | REST |
| --- | ---: | --- | --- |
| list | 50% | `query todoItems(skip,take) { … }` | `GET /todo-items?skip&take` |
| byId | 25% | `query todoItem(id) { … }` | `GET /todo-items/:id` |
| create | 15% | `mutation createOneTodoItem(input)` | `POST /todo-items` |
| merge | 10% | `mutation mergeTodoItem(id,input)` (Set/array/Map merges) | `PATCH /todo-items/:id/merge` (same merges) |

## Load sizes

| size | connections | duration | warmup |
| --- | ---: | ---: | ---: |
| small | 20 | 5s | 1s |
| medium | 50 | 10s | 2s |
| large | 100 | 15s | 3s |

Each cell below is **mean ± stddev** across the runs. RPS rows show a `(min..max)` band so reproducibility is visible.

## Small load (20 conn × 5s)

### GRAPHQL (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| graphql-nest-express | 3334 ± 55 _(3272..3431)_ | 5.9 ± 0.1 | 17.6 ± 0.4 | 249.3 ± 8.0 | 263.3 | 263.3 | 0 |
| graphql-nest-fastify | 3368 ± 35 _(3304..3408)_ | 5.8 ± 0.0 | 17.9 ± 0.2 | 245.8 ± 7.9 | 258.5 | 258.5 | 0 |
| **graphql-nest-bun** | 3305 ± 41 _(3248..3367)_ | 5.9 ± 0.1 | 18.3 ± 0.3 | 225.0 ± 15.4 | 247.2 | 247.2 | 0 |

## Medium load (50 conn × 10s)

### GRAPHQL (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| graphql-nest-express | 3190 ± 169 _(2916..3447)_ | 15.4 ± 0.8 | 31.4 ± 2.6 | 253.3 ± 13.4 | 271.3 | 271.7 | 0 |
| graphql-nest-fastify | 3096 ± 133 _(2856..3237)_ | 16.0 ± 0.7 | 32.1 ± 1.7 | 266.1 ± 19.8 | 297.0 | 298.6 | 0 |
| **graphql-nest-bun** | 3203 ± 114 _(3084..3364)_ | 15.4 ± 0.5 | 31.2 ± 1.5 | 258.3 ± 3.8 | 276.5 | 276.5 | 0 |

## Large load (100 conn × 15s)

### GRAPHQL (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| graphql-nest-express | 3330 ± 21 _(3309..3367)_ | 29.4 ± 0.2 | 43.9 ± 5.6 | 254.6 ± 8.0 | 272.8 | 273.9 | 0 |
| graphql-nest-fastify | 3347 ± 16 _(3322..3367)_ | 29.4 ± 0.2 | 54.4 ± 1.2 | 308.0 ± 7.9 | 336.5 | 336.7 | 0 |
| **graphql-nest-bun** | 3375 ± 15 _(3360..3402)_ | 29.2 ± 0.2 | 53.4 ± 2.1 | 270.4 ± 1.7 | 282.6 | 282.7 | 0 |

## GraphQL driver: Apollo vs Yoga (on bun)

Same hand-written resolver / service / DTOs / CASL — only the GraphQL **driver** differs. `graphql-nest-bun` uses `@nestjs/apollo` (ApolloDriver); `graphql-nest-bun-yoga` uses GraphQL Yoga via the experimental `BunYogaDriver` (fetch-native — feeds the raw Web `Request` to Yoga, no Node `req`/`res` bridge). Both run on `BunHttpAdapter`. `Δ` is Yoga relative to Apollo.

| size | Apollo RPS | Yoga RPS | Δ RPS | Apollo p99 | Yoga p99 | Δ p99 | Apollo RSS | Yoga RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| small | 3305 | **5235** | +58.4% | 18.3 | 11.0 | -40.1% | 225.0 | 230.0 |
| medium | 3203 | **4944** | +54.4% | 31.2 | 20.1 | -35.6% | 258.3 | 247.4 |
| large | 3375 | **5294** | +56.9% | 53.4 | 33.0 | -38.2% | 270.4 | 259.6 |

> `graphql-nest-bun-yoga` is experimental bench-only tooling (`tests/bench/frameworks/graphql/bun-yoga-driver.ts`), not part of the published adapter. Regenerate with `bun run tests/bench/run-matrix.ts --with-yoga`.

## Findings

Narrative analysis that outlives a regeneration — why GraphQL on `bun` trails `express`, and how the Bun 1.4.0 upgrade moved the standings — lives in [`BENCHMARK-FINDINGS.md`](./BENCHMARK-FINDINGS.md).

## Notes

- All load is driven by an external **k6** process so the generator never shares a runtime or cores with the server under test. An in-process Bun `fetch` client systematically under-reports the bun target because client and server contend for the same single-threaded JSC runtime; k6 removes that bias. For REST this flips the headline result; for GraphQL the effect is within noise (per-request server work dominates), but k6 is used for both so a single instrument measures every target.
- RSS is captured by polling `ps -o rss= -p <pid>` every 250 ms during the measurement window only (warmup excluded so JIT/heap growth does not skew the idle baseline).
- Idle RSS is sampled once right after the target becomes ready, before warmup and traffic.
- The "GraphQL tax" reflects the cost of `@nestjs/apollo` + Apollo Server execution + GraphQL parsing + `@ResolveField` dispatch on top of the same business logic. It does **not** include network/transport costs that would differ in a real-world deployment.
- Each REST endpoint projects its response to the exact field set the matching GraphQL query selects (including mirroring GraphQL `ID`-scalar fields as strings, emitting selected-but-null fields, and resolving `assignee` only where the selection asks). Verified byte-identical per op (list/byId/create/merge) modulo GraphQL's `{"data":{…}}` envelope (~20 bytes), so payload encode/decode cost is equal on both sides.
- Numbers fluctuate ±5–10% across runs on M-series Macs because of thermal throttling. Always re-measure on the target hardware.
