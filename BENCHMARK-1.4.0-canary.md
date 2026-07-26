# NestJS Bun Adapter — GraphQL vs REST Benchmark

Generated 2026-07-26 18:06:04 UTC.

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
| graphql-nest-express | 3295 ± 39 _(3246..3352)_ | 6.0 ± 0.1 | 17.1 ± 0.2 | 246.7 ± 2.3 | 257.8 | 257.8 | 0 |
| graphql-nest-fastify | 3188 ± 8 _(3179..3203)_ | 6.2 ± 0.0 | 17.7 ± 0.2 | 246.2 ± 4.1 | 252.0 | 252.0 | 0 |
| **graphql-nest-bun** | 3320 ± 59 _(3228..3404)_ | 5.9 ± 0.1 | 17.3 ± 0.4 | 224.6 ± 1.8 | 230.2 | 230.2 | 0 |

### REST (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| rest-nest-express | 13118 ± 98 _(13020..13260)_ | 1.4 ± 0.0 | 3.8 ± 0.1 | 200.1 ± 2.6 | 206.4 | 206.4 | 0 |
| rest-nest-fastify | 14148 ± 138 _(13955..14321)_ | 1.3 ± 0.0 | 3.5 ± 0.0 | 189.8 ± 1.1 | 206.5 | 206.5 | 0 |
| **rest-nest-bun** | 15153 ± 96 _(15031..15259)_ | 1.2 ± 0.0 | 3.3 ± 0.0 | 161.1 ± 3.6 | 173.4 | 173.4 | 0 |

### small — GraphQL tax (same adapter, REST as baseline)

`Δ RPS` = `(GraphQL − REST) / REST` (negative = GraphQL slower); `Δ p99` likewise. `Δ RSS` is GraphQL minus REST in MB. 

| adapter | REST RPS | GraphQL RPS | Δ RPS | REST p99 | GraphQL p99 | Δ p99 | REST RSS | GraphQL RSS | Δ RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 13118 | 3295 | -74.9% | 3.8 | 17.1 | +347.7% | 200.1 | 246.7 | +46.6 |
| fastify | 14148 | 3188 | -77.5% | 3.5 | 17.7 | +408.2% | 189.8 | 246.2 | +56.4 |
| **bun** | 15153 | 3320 | -78.1% | 3.3 | 17.3 | +418.0% | 161.1 | 224.6 | +63.6 |

## Medium load (50 conn × 10s)

### GRAPHQL (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| graphql-nest-express | 3304 ± 43 _(3228..3358)_ | 15.0 ± 0.2 | 28.7 ± 0.5 | 277.0 ± 1.4 | 288.7 | 288.7 | 0 |
| graphql-nest-fastify | 3078 ± 38 _(3037..3136)_ | 16.1 ± 0.2 | 30.8 ± 0.6 | 284.1 ± 3.4 | 315.1 | 316.6 | 0 |
| **graphql-nest-bun** | 3226 ± 21 _(3186..3247)_ | 15.3 ± 0.1 | 29.3 ± 0.1 | 256.3 ± 3.5 | 280.2 | 280.2 | 0 |

### REST (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| rest-nest-express | 12790 ± 46 _(12748..12876)_ | 3.8 ± 0.0 | 7.8 ± 0.1 | 217.9 ± 3.3 | 238.9 | 239.4 | 0 |
| rest-nest-fastify | 13727 ± 94 _(13609..13896)_ | 3.5 ± 0.0 | 6.9 ± 0.1 | 224.7 ± 3.4 | 268.3 | 269.7 | 0 |
| **rest-nest-bun** | 14829 ± 84 _(14730..14976)_ | 3.3 ± 0.0 | 6.4 ± 0.0 | 186.7 ± 1.4 | 217.6 | 218.3 | 0 |

### medium — GraphQL tax (same adapter, REST as baseline)

`Δ RPS` = `(GraphQL − REST) / REST` (negative = GraphQL slower); `Δ p99` likewise. `Δ RSS` is GraphQL minus REST in MB. 

| adapter | REST RPS | GraphQL RPS | Δ RPS | REST p99 | GraphQL p99 | Δ p99 | REST RSS | GraphQL RSS | Δ RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 12790 | 3304 | -74.2% | 7.8 | 28.7 | +267.4% | 217.9 | 277.0 | +59.1 |
| fastify | 13727 | 3078 | -77.6% | 6.9 | 30.8 | +349.0% | 224.7 | 284.1 | +59.3 |
| **bun** | 14829 | 3226 | -78.2% | 6.4 | 29.3 | +357.2% | 186.7 | 256.3 | +69.6 |

## Large load (100 conn × 15s)

### GRAPHQL (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| graphql-nest-express | 3320 ± 23 _(3283..3348)_ | 30.0 ± 0.2 | 35.5 ± 0.4 | 275.9 ± 5.4 | 285.7 | 286.2 | 0 |
| graphql-nest-fastify | 3109 ± 43 _(3047..3165)_ | 32.1 ± 0.4 | 36.3 ± 0.6 | 311.0 ± 4.2 | 340.5 | 340.6 | 0 |
| **graphql-nest-bun** | 3245 ± 46 _(3168..3291)_ | 30.7 ± 0.5 | 35.6 ± 1.4 | 262.7 ± 14.6 | 280.8 | 281.1 | 0 |

### REST (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| rest-nest-express | 12895 ± 70 _(12821..12980)_ | 7.6 ± 0.1 | 12.9 ± 0.2 | 232.2 ± 5.3 | 258.6 | 260.7 | 0 |
| rest-nest-fastify | 13609 ± 76 _(13489..13716)_ | 7.2 ± 0.0 | 10.6 ± 0.5 | 249.7 ± 10.7 | 293.8 | 295.0 | 0 |
| **rest-nest-bun** | 14597 ± 71 _(14465..14675)_ | 6.7 ± 0.0 | 10.6 ± 0.2 | 200.4 ± 3.2 | 232.8 | 233.9 | 0 |

### large — GraphQL tax (same adapter, REST as baseline)

`Δ RPS` = `(GraphQL − REST) / REST` (negative = GraphQL slower); `Δ p99` likewise. `Δ RSS` is GraphQL minus REST in MB. 

| adapter | REST RPS | GraphQL RPS | Δ RPS | REST p99 | GraphQL p99 | Δ p99 | REST RSS | GraphQL RSS | Δ RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 12895 | 3320 | -74.3% | 12.9 | 35.5 | +174.7% | 232.2 | 275.9 | +43.7 |
| fastify | 13609 | 3109 | -77.2% | 10.6 | 36.3 | +241.4% | 249.7 | 311.0 | +61.3 |
| **bun** | 14597 | 3245 | -77.8% | 10.6 | 35.6 | +234.4% | 200.4 | 262.7 | +62.3 |

## Notes

- All load is driven by an external **k6** process so the generator never shares a runtime or cores with the server under test. An in-process Bun `fetch` client systematically under-reports the bun target because client and server contend for the same single-threaded JSC runtime; k6 removes that bias. For REST this flips the headline result; for GraphQL the effect is within noise (per-request server work dominates), but k6 is used for both so a single instrument measures every target.
- RSS is captured by polling `ps -o rss= -p <pid>` every 250 ms during the measurement window only (warmup excluded so JIT/heap growth does not skew the idle baseline).
- Idle RSS is sampled once right after the target becomes ready, before warmup and traffic.
- The "GraphQL tax" reflects the cost of `@nestjs/apollo` + Apollo Server execution + GraphQL parsing + `@ResolveField` dispatch on top of the same business logic. It does **not** include network/transport costs that would differ in a real-world deployment.
- Each REST endpoint projects its response to the exact field set the matching GraphQL query selects (including mirroring GraphQL `ID`-scalar fields as strings, emitting selected-but-null fields, and resolving `assignee` only where the selection asks). Verified byte-identical per op (list/byId/create/merge) modulo GraphQL's `{"data":{…}}` envelope (~20 bytes), so payload encode/decode cost is equal on both sides.
- Numbers fluctuate ±5–10% across runs on M-series Macs because of thermal throttling. Always re-measure on the target hardware.
