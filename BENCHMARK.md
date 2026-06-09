# NestJS Bun Adapter — GraphQL vs REST Benchmark

Generated 2026-06-09 20:40:24 UTC.

## Environment

- **Host**: Mac.asus.com (darwin 25.3.0)  
- **Total RAM**: 48.0 GB  
- **Bun**: 1.3.5  
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
| graphql-nest-express | 2581 ± 186 _(2283..2794)_ | 6.4 ± 0.2 | 30.1 ± 12.4 | 290.6 ± 13.8 | 307.3 | 307.3 | 0 |
| graphql-nest-fastify | 2684 ± 71 _(2550..2746)_ | 6.1 ± 0.2 | 21.0 ± 0.6 | 294.6 ± 3.0 | 316.9 | 316.9 | 0 |
| **graphql-nest-bun** | 2837 ± 132 _(2589..2971)_ | 6.7 ± 0.2 | 21.7 ± 2.0 | 273.3 ± 11.8 | 290.2 | 290.4 | 0 |

### REST (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| rest-nest-express | 11567 ± 582 _(10545..12145)_ | 1.3 ± 0.0 | 5.5 ± 0.4 | 218.1 ± 22.6 | 238.9 | 239.0 | 0 |
| rest-nest-fastify | 12715 ± 123 _(12533..12869)_ | 1.2 ± 0.0 | 4.9 ± 0.0 | 228.8 ± 11.7 | 251.5 | 252.2 | 0 |
| **rest-nest-bun** | 13371 ± 533 _(12354..13839)_ | 1.4 ± 0.0 | 4.0 ± 0.7 | 208.4 ± 25.3 | 226.2 | 226.2 | 0 |

### small — GraphQL tax (same adapter, REST as baseline)

`Δ RPS` = `(GraphQL − REST) / REST` (negative = GraphQL slower); `Δ p99` likewise. `Δ RSS` is GraphQL minus REST in MB. 

| adapter | REST RPS | GraphQL RPS | Δ RPS | REST p99 | GraphQL p99 | Δ p99 | REST RSS | GraphQL RSS | Δ RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 11567 | 2581 | -77.7% | 5.5 | 30.1 | +444.6% | 218.1 | 290.6 | +72.4 |
| fastify | 12715 | 2684 | -78.9% | 4.9 | 21.0 | +332.2% | 228.8 | 294.6 | +65.8 |
| **bun** | 13371 | 2837 | -78.8% | 4.0 | 21.7 | +443.6% | 208.4 | 273.3 | +64.9 |

## Medium load (50 conn × 10s)

### GRAPHQL (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| graphql-nest-express | 2693 ± 62 _(2622..2810)_ | 18.4 ± 0.4 | 38.4 ± 1.0 | 317.5 ± 6.8 | 330.9 | 330.9 | 0 |
| graphql-nest-fastify | 2503 ± 32 _(2444..2535)_ | 19.5 ± 0.2 | 48.9 ± 13.5 | 317.5 ± 16.0 | 352.9 | 354.8 | 0 |
| **graphql-nest-bun** | 2702 ± 154 _(2429..2891)_ | 18.0 ± 0.6 | 44.2 ± 14.6 | 275.0 ± 22.4 | 299.6 | 301.0 | 0 |

### REST (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| rest-nest-express | 11030 ± 210 _(10647..11264)_ | 4.6 ± 0.0 | 11.2 ± 1.5 | 238.7 ± 21.6 | 259.9 | 260.1 | 0 |
| rest-nest-fastify | 11727 ± 248 _(11319..11958)_ | 4.3 ± 0.0 | 10.2 ± 0.6 | 246.2 ± 18.7 | 279.1 | 280.8 | 0 |
| **rest-nest-bun** | 12954 ± 242 _(12475..13135)_ | 3.7 ± 0.0 | 7.6 ± 0.5 | 220.4 ± 12.1 | 247.2 | 247.9 | 0 |

### medium — GraphQL tax (same adapter, REST as baseline)

`Δ RPS` = `(GraphQL − REST) / REST` (negative = GraphQL slower); `Δ p99` likewise. `Δ RSS` is GraphQL minus REST in MB. 

| adapter | REST RPS | GraphQL RPS | Δ RPS | REST p99 | GraphQL p99 | Δ p99 | REST RSS | GraphQL RSS | Δ RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 11030 | 2693 | -75.6% | 11.2 | 38.4 | +241.8% | 238.7 | 317.5 | +78.8 |
| fastify | 11727 | 2503 | -78.7% | 10.2 | 48.9 | +381.4% | 246.2 | 317.5 | +71.2 |
| **bun** | 12954 | 2702 | -79.1% | 7.6 | 44.2 | +481.0% | 220.4 | 275.0 | +54.6 |

## Large load (100 conn × 15s)

### GRAPHQL (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| graphql-nest-express | 2724 ± 60 _(2632..2818)_ | 36.7 ± 0.9 | 75.3 ± 1.9 | 311.4 ± 15.0 | 334.4 | 334.4 | 0 |
| graphql-nest-fastify | 2626 ± 153 _(2471..2879)_ | 37.6 ± 1.6 | 100.9 ± 25.5 | 320.7 ± 26.7 | 349.0 | 352.7 | 0 |
| **graphql-nest-bun** | 2847 ± 75 _(2731..2952)_ | 34.4 ± 0.9 | 56.1 ± 12.1 | 275.9 ± 23.4 | 295.5 | 296.0 | 0 |

### REST (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| rest-nest-express | 10141 ± 106 _(10030..10298)_ | 10.0 ± 0.1 | 23.5 ± 2.9 | 257.1 ± 16.2 | 288.4 | 291.1 | 0 |
| rest-nest-fastify | 11176 ± 178 _(11001..11519)_ | 9.4 ± 0.1 | 18.2 ± 0.4 | 287.1 ± 14.2 | 312.2 | 313.7 | 0 |
| **rest-nest-bun** | 13212 ± 221 _(12775..13375)_ | 7.2 ± 0.0 | 13.7 ± 1.7 | 236.9 ± 21.3 | 264.4 | 270.5 | 0 |

### large — GraphQL tax (same adapter, REST as baseline)

`Δ RPS` = `(GraphQL − REST) / REST` (negative = GraphQL slower); `Δ p99` likewise. `Δ RSS` is GraphQL minus REST in MB. 

| adapter | REST RPS | GraphQL RPS | Δ RPS | REST p99 | GraphQL p99 | Δ p99 | REST RSS | GraphQL RSS | Δ RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 10141 | 2724 | -73.1% | 23.5 | 75.3 | +220.4% | 257.1 | 311.4 | +54.2 |
| fastify | 11176 | 2626 | -76.5% | 18.2 | 100.9 | +455.0% | 287.1 | 320.7 | +33.7 |
| **bun** | 13212 | 2847 | -78.5% | 13.7 | 56.1 | +308.7% | 236.9 | 275.9 | +39.1 |

## GraphQL driver: Apollo vs Yoga (on bun)

Same hand-written resolver / service / DTOs / CASL — only the GraphQL **driver** differs. `graphql-nest-bun` uses `@nestjs/apollo` (ApolloDriver); `graphql-nest-bun-yoga` uses GraphQL Yoga via the experimental `BunYogaDriver` (fetch-native — feeds the raw Web `Request` to Yoga, no Node `req`/`res` bridge). Both run on `BunHttpAdapter`. `Δ` is Yoga relative to Apollo.

| size | Apollo RPS | Yoga RPS | Δ RPS | Apollo p99 | Yoga p99 | Δ p99 | Apollo RSS | Yoga RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| small | 2837 | **4148** | +46.2% | 21.7 | 12.2 | -43.6% | 273.3 | 290.1 |
| medium | 2702 | **3863** | +43.0% | 44.2 | 27.1 | -38.8% | 275.0 | 266.4 |
| large | 2847 | **4107** | +44.3% | 56.1 | 30.2 | -46.2% | 275.9 | 301.3 |

> `graphql-nest-bun-yoga` is experimental bench-only tooling (`tests/bench/frameworks/graphql/bun-yoga-driver.ts`), not part of the published adapter. Regenerate with `bun run tests/bench/run-matrix.ts --with-yoga`.

## Notes

- All load is driven by an external **k6** process so the generator never shares a runtime or cores with the server under test. An in-process Bun `fetch` client systematically under-reports the bun target because client and server contend for the same single-threaded JSC runtime; k6 removes that bias. For REST this flips the headline result; for GraphQL the effect is within noise (per-request server work dominates), but k6 is used for both so a single instrument measures every target.
- RSS is captured by polling `ps -o rss= -p <pid>` every 250 ms during the measurement window only (warmup excluded so JIT/heap growth does not skew the idle baseline).
- Idle RSS is sampled once right after the target becomes ready, before warmup and traffic.
- The "GraphQL tax" reflects the cost of `@nestjs/apollo` + Apollo Server execution + GraphQL parsing + `@ResolveField` dispatch on top of the same business logic. It does **not** include network/transport costs that would differ in a real-world deployment.
- Each REST endpoint projects its response to the exact field set the matching GraphQL query selects (including mirroring GraphQL `ID`-scalar fields as strings, emitting selected-but-null fields, and resolving `assignee` only where the selection asks). Verified byte-identical per op (list/byId/create/merge) modulo GraphQL's `{"data":{…}}` envelope (~20 bytes), so payload encode/decode cost is equal on both sides.
- Numbers fluctuate ±5–10% across runs on M-series Macs because of thermal throttling. Always re-measure on the target hardware.
