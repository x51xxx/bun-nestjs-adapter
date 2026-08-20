# NestJS Bun Adapter — GraphQL vs REST Benchmark

Generated 2026-08-20 17:27:18 UTC.

## Environment

- **Host**: MacBook-Pro-Taras.local (darwin 25.3.0)  
- **Total RAM**: 48.0 GB  
- **Bun**: 1.4.0  
- **Runs per (size × protocol)**: 5  
- **Protocols**: graphql, rest  
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
| graphql-nest-express | 3391 ± 26 _(3356..3429)_ | 5.8 ± 0.1 | 17.1 ± 0.2 | 253.4 ± 6.1 | 265.6 | 265.6 | 0 |
| graphql-nest-fastify | 3382 ± 33 _(3345..3444)_ | 5.8 ± 0.1 | 17.8 ± 0.3 | 251.0 ± 7.5 | 267.0 | 267.0 | 0 |
| **graphql-nest-bun** | 3336 ± 150 _(3044..3473)_ | 5.8 ± 0.2 | 18.6 ± 1.7 | 234.8 ± 5.6 | 249.8 | 249.8 | 0 |

### REST (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| rest-nest-express | 13942 ± 431 _(13175..14365)_ | 1.3 ± 0.0 | 3.9 ± 0.4 | 225.1 ± 11.8 | 236.2 | 236.2 | 0 |
| rest-nest-fastify | 14976 ± 640 _(13948..15700)_ | 1.2 ± 0.0 | 3.5 ± 0.5 | 203.1 ± 13.7 | 217.6 | 217.6 | 0 |
| **rest-nest-bun** | 16228 ± 527 _(15199..16631)_ | 1.2 ± 0.0 | 3.2 ± 0.3 | 175.4 ± 4.8 | 188.1 | 188.1 | 0 |

### small — GraphQL tax (same adapter, REST as baseline)

`Δ RPS` = `(GraphQL − REST) / REST` (negative = GraphQL slower); `Δ p99` likewise. `Δ RSS` is GraphQL minus REST in MB. 

| adapter | REST RPS | GraphQL RPS | Δ RPS | REST p99 | GraphQL p99 | Δ p99 | REST RSS | GraphQL RSS | Δ RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 13942 | 3391 | -75.7% | 3.9 | 17.1 | +342.2% | 225.1 | 253.4 | +28.3 |
| fastify | 14976 | 3382 | -77.4% | 3.5 | 17.8 | +405.5% | 203.1 | 251.0 | +47.9 |
| **bun** | 16228 | 3336 | -79.4% | 3.2 | 18.6 | +478.0% | 175.4 | 234.8 | +59.4 |

## Medium load (50 conn × 10s)

### GRAPHQL (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| graphql-nest-express | 3291 ± 140 _(3019..3386)_ | 14.9 ± 0.4 | 31.3 ± 4.0 | 250.1 ± 8.9 | 262.2 | 262.9 | 0 |
| graphql-nest-fastify | 3322 ± 45 _(3289..3409)_ | 14.9 ± 0.2 | 29.7 ± 0.5 | 278.0 ± 8.4 | 308.8 | 312.1 | 0 |
| **graphql-nest-bun** | 3350 ± 42 _(3291..3397)_ | 14.7 ± 0.1 | 29.5 ± 0.5 | 258.7 ± 1.6 | 279.5 | 279.6 | 0 |

### REST (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| rest-nest-express | 13808 ± 206 _(13415..13984)_ | 3.5 ± 0.0 | 7.4 ± 0.3 | 244.4 ± 13.5 | 267.2 | 267.7 | 0 |
| rest-nest-fastify | 14915 ± 103 _(14745..15061)_ | 3.2 ± 0.0 | 6.6 ± 0.1 | 240.1 ± 9.6 | 278.9 | 280.9 | 0 |
| **rest-nest-bun** | 15861 ± 304 _(15290..16181)_ | 3.0 ± 0.0 | 6.5 ± 0.5 | 197.8 ± 10.6 | 227.6 | 227.6 | 0 |

### medium — GraphQL tax (same adapter, REST as baseline)

`Δ RPS` = `(GraphQL − REST) / REST` (negative = GraphQL slower); `Δ p99` likewise. `Δ RSS` is GraphQL minus REST in MB. 

| adapter | REST RPS | GraphQL RPS | Δ RPS | REST p99 | GraphQL p99 | Δ p99 | REST RSS | GraphQL RSS | Δ RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 13808 | 3291 | -76.2% | 7.4 | 31.3 | +320.7% | 244.4 | 250.1 | +5.7 |
| fastify | 14915 | 3322 | -77.7% | 6.6 | 29.7 | +350.1% | 240.1 | 278.0 | +37.9 |
| **bun** | 15861 | 3350 | -78.9% | 6.5 | 29.5 | +356.2% | 197.8 | 258.7 | +60.9 |

## Large load (100 conn × 15s)

### GRAPHQL (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| graphql-nest-express | 3374 ± 47 _(3312..3433)_ | 29.1 ± 0.3 | 44.4 ± 7.6 | 262.6 ± 15.7 | 276.8 | 278.6 | 0 |
| graphql-nest-fastify | 3317 ± 34 _(3274..3376)_ | 29.6 ± 0.2 | 54.7 ± 2.5 | 311.2 ± 2.3 | 339.7 | 339.9 | 0 |
| **graphql-nest-bun** | 3402 ± 33 _(3344..3428)_ | 28.9 ± 0.3 | 53.8 ± 0.8 | 269.6 ± 4.3 | 281.7 | 281.9 | 0 |

### REST (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| rest-nest-express | 14021 ± 111 _(13853..14143)_ | 6.8 ± 0.0 | 12.9 ± 0.3 | 255.9 ± 9.7 | 284.4 | 288.2 | 0 |
| rest-nest-fastify | 15123 ± 115 _(14974..15279)_ | 6.3 ± 0.0 | 12.0 ± 0.1 | 271.9 ± 1.2 | 319.4 | 323.3 | 0 |
| **rest-nest-bun** | 16210 ± 54 _(16127..16289)_ | 5.9 ± 0.0 | 11.2 ± 0.1 | 223.9 ± 3.4 | 271.4 | 272.5 | 0 |

### large — GraphQL tax (same adapter, REST as baseline)

`Δ RPS` = `(GraphQL − REST) / REST` (negative = GraphQL slower); `Δ p99` likewise. `Δ RSS` is GraphQL minus REST in MB. 

| adapter | REST RPS | GraphQL RPS | Δ RPS | REST p99 | GraphQL p99 | Δ p99 | REST RSS | GraphQL RSS | Δ RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 14021 | 3374 | -75.9% | 12.9 | 44.4 | +244.5% | 255.9 | 262.6 | +6.7 |
| fastify | 15123 | 3317 | -78.1% | 12.0 | 54.7 | +356.7% | 271.9 | 311.2 | +39.3 |
| **bun** | 16210 | 3402 | -79.0% | 11.2 | 53.8 | +379.1% | 223.9 | 269.6 | +45.7 |

## Findings

Narrative analysis that outlives a regeneration — why GraphQL on `bun` trails `express`, and how the Bun 1.4.0 upgrade moved the standings — lives in [`BENCHMARK-FINDINGS.md`](./BENCHMARK-FINDINGS.md).

## Notes

- All load is driven by an external **k6** process so the generator never shares a runtime or cores with the server under test. An in-process Bun `fetch` client systematically under-reports the bun target because client and server contend for the same single-threaded JSC runtime; k6 removes that bias. For REST this flips the headline result; for GraphQL the effect is within noise (per-request server work dominates), but k6 is used for both so a single instrument measures every target.
- RSS is captured by polling `ps -o rss= -p <pid>` every 250 ms during the measurement window only (warmup excluded so JIT/heap growth does not skew the idle baseline).
- Idle RSS is sampled once right after the target becomes ready, before warmup and traffic.
- The "GraphQL tax" reflects the cost of `@nestjs/apollo` + Apollo Server execution + GraphQL parsing + `@ResolveField` dispatch on top of the same business logic. It does **not** include network/transport costs that would differ in a real-world deployment.
- Each REST endpoint projects its response to the exact field set the matching GraphQL query selects (including mirroring GraphQL `ID`-scalar fields as strings, emitting selected-but-null fields, and resolving `assignee` only where the selection asks). Verified byte-identical per op (list/byId/create/merge) modulo GraphQL's `{"data":{…}}` envelope (~20 bytes), so payload encode/decode cost is equal on both sides.
- Numbers fluctuate ±5–10% across runs on M-series Macs because of thermal throttling. Always re-measure on the target hardware.
