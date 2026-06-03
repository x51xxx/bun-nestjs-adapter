# NestJS Bun Adapter — GraphQL vs REST Benchmark

Generated 2026-06-03 19:24:17 UTC.

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
| graphql-nest-express | 2695 ± 68 _(2570..2772)_ | 6.4 ± 0.1 | 19.9 ± 0.8 | 304.9 ± 1.5 | 322.1 | 322.1 | 0 |
| graphql-nest-fastify | 2672 ± 42 _(2601..2712)_ | 6.2 ± 0.1 | 20.9 ± 0.4 | 294.9 ± 1.4 | 319.4 | 319.4 | 0 |
| **graphql-nest-bun** | 2846 ± 25 _(2806..2868)_ | 6.7 ± 0.1 | 21.2 ± 0.2 | 275.5 ± 1.1 | 292.4 | 292.4 | 0 |

### REST (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| rest-nest-express | 11797 ± 43 _(11749..11878)_ | 1.3 ± 0.0 | 5.4 ± 0.0 | 234.2 ± 1.5 | 242.7 | 242.7 | 0 |
| rest-nest-fastify | 12738 ± 68 _(12675..12869)_ | 1.2 ± 0.0 | 4.9 ± 0.1 | 237.3 ± 1.1 | 260.5 | 260.5 | 0 |
| **rest-nest-bun** | 13666 ± 35 _(13611..13711)_ | 1.4 ± 0.0 | 3.7 ± 0.0 | 212.8 ± 2.4 | 231.5 | 231.5 | 0 |

### small — GraphQL tax (same adapter, REST as baseline)

`Δ RPS` = `(GraphQL − REST) / REST` (negative = GraphQL slower); `Δ p99` likewise. `Δ RSS` is GraphQL minus REST in MB. 

| adapter | REST RPS | GraphQL RPS | Δ RPS | REST p99 | GraphQL p99 | Δ p99 | REST RSS | GraphQL RSS | Δ RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 11797 | 2695 | -77.2% | 5.4 | 19.9 | +270.9% | 234.2 | 304.9 | +70.8 |
| fastify | 12738 | 2672 | -79.0% | 4.9 | 20.9 | +329.0% | 237.3 | 294.9 | +57.6 |
| **bun** | 13666 | 2846 | -79.2% | 3.7 | 21.2 | +478.3% | 212.8 | 275.5 | +62.7 |

## Medium load (50 conn × 10s)

### GRAPHQL (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| graphql-nest-express | 2774 ± 62 _(2661..2833)_ | 17.9 ± 0.4 | 37.1 ± 0.9 | 327.8 ± 1.2 | 332.6 | 332.6 | 0 |
| graphql-nest-fastify | 2594 ± 56 _(2508..2683)_ | 19.2 ± 0.4 | 39.8 ± 0.8 | 335.9 ± 1.8 | 370.4 | 371.4 | 0 |
| **graphql-nest-bun** | 2877 ± 52 _(2787..2947)_ | 17.2 ± 0.3 | 32.2 ± 0.9 | 302.1 ± 1.7 | 320.1 | 320.1 | 0 |

### REST (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| rest-nest-express | 11139 ± 43 _(11083..11187)_ | 4.6 ± 0.0 | 10.4 ± 0.1 | 259.7 ± 2.2 | 281.3 | 281.3 | 0 |
| rest-nest-fastify | 11831 ± 51 _(11743..11880)_ | 4.3 ± 0.0 | 9.8 ± 0.1 | 275.9 ± 1.1 | 306.0 | 306.0 | 0 |
| **rest-nest-bun** | 13099 ± 18 _(13073..13123)_ | 3.7 ± 0.0 | 7.3 ± 0.0 | 239.0 ± 3.4 | 260.4 | 260.9 | 0 |

### medium — GraphQL tax (same adapter, REST as baseline)

`Δ RPS` = `(GraphQL − REST) / REST` (negative = GraphQL slower); `Δ p99` likewise. `Δ RSS` is GraphQL minus REST in MB. 

| adapter | REST RPS | GraphQL RPS | Δ RPS | REST p99 | GraphQL p99 | Δ p99 | REST RSS | GraphQL RSS | Δ RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 11139 | 2774 | -75.1% | 10.4 | 37.1 | +255.2% | 259.7 | 327.8 | +68.1 |
| fastify | 11831 | 2594 | -78.1% | 9.8 | 39.8 | +305.3% | 275.9 | 335.9 | +60.0 |
| **bun** | 13099 | 2877 | -78.0% | 7.3 | 32.2 | +340.7% | 239.0 | 302.1 | +63.1 |

## Large load (100 conn × 15s)

### GRAPHQL (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| graphql-nest-express | 2703 ± 39 _(2655..2765)_ | 36.9 ± 0.5 | 74.7 ± 1.1 | 336.8 ± 3.0 | 343.1 | 343.2 | 0 |
| graphql-nest-fastify | 2710 ± 59 _(2653..2797)_ | 37.0 ± 1.0 | 75.2 ± 1.6 | 357.8 ± 2.6 | 378.3 | 379.1 | 0 |
| **graphql-nest-bun** | 2885 ± 23 _(2861..2923)_ | 34.3 ± 0.3 | 40.8 ± 0.8 | 311.2 ± 2.6 | 321.5 | 321.6 | 0 |

### REST (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| rest-nest-express | 10410 ± 39 _(10359..10466)_ | 10.1 ± 0.1 | 19.7 ± 0.1 | 293.3 ± 2.6 | 329.4 | 329.6 | 0 |
| rest-nest-fastify | 11094 ± 23 _(11070..11138)_ | 9.5 ± 0.0 | 18.1 ± 0.1 | 313.0 ± 0.5 | 339.2 | 342.4 | 0 |
| **rest-nest-bun** | 13424 ± 103 _(13333..13613)_ | 7.2 ± 0.1 | 12.0 ± 0.3 | 254.2 ± 4.6 | 281.1 | 283.8 | 0 |

### large — GraphQL tax (same adapter, REST as baseline)

`Δ RPS` = `(GraphQL − REST) / REST` (negative = GraphQL slower); `Δ p99` likewise. `Δ RSS` is GraphQL minus REST in MB. 

| adapter | REST RPS | GraphQL RPS | Δ RPS | REST p99 | GraphQL p99 | Δ p99 | REST RSS | GraphQL RSS | Δ RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 10410 | 2703 | -74.0% | 19.7 | 74.7 | +279.6% | 293.3 | 336.8 | +43.5 |
| fastify | 11094 | 2710 | -75.6% | 18.1 | 75.2 | +315.0% | 313.0 | 357.8 | +44.8 |
| **bun** | 13424 | 2885 | -78.5% | 12.0 | 40.8 | +239.7% | 254.2 | 311.2 | +57.0 |

## GraphQL driver: Apollo vs Yoga (on bun)

Same hand-written resolver / service / DTOs / CASL — only the GraphQL **driver** differs. `graphql-nest-bun` uses `@nestjs/apollo` (ApolloDriver); `graphql-nest-bun-yoga` uses GraphQL Yoga via the experimental `BunYogaDriver` (fetch-native — feeds the raw Web `Request` to Yoga, no Node `req`/`res` bridge). Both run on `BunHttpAdapter`. `Δ` is Yoga relative to Apollo.

| size | Apollo RPS | Yoga RPS | Δ RPS | Apollo p99 | Yoga p99 | Δ p99 | Apollo RSS | Yoga RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| small | 2846 | **4161** | +46.2% | 21.2 | 12.1 | -42.9% | 275.5 | 290.8 |
| medium | 2877 | **3940** | +36.9% | 32.2 | 24.2 | -24.9% | 302.1 | 314.4 |
| large | 2885 | **4035** | +39.9% | 40.8 | 29.8 | -27.0% | 311.2 | 335.7 |

> `graphql-nest-bun-yoga` is experimental bench-only tooling (`tests/bench/frameworks/graphql/bun-yoga-driver.ts`), not part of the published adapter. Regenerate with `bun run tests/bench/run-matrix.ts --with-yoga`.

## Notes

- All load is driven by an external **k6** process so the generator never shares a runtime or cores with the server under test. An in-process Bun `fetch` client systematically under-reports the bun target because client and server contend for the same single-threaded JSC runtime; k6 removes that bias. For REST this flips the headline result; for GraphQL the effect is within noise (per-request server work dominates), but k6 is used for both so a single instrument measures every target.
- RSS is captured by polling `ps -o rss= -p <pid>` every 250 ms during the measurement window only (warmup excluded so JIT/heap growth does not skew the idle baseline).
- Idle RSS is sampled once right after the target becomes ready, before warmup and traffic.
- The "GraphQL tax" reflects the cost of `@nestjs/apollo` + Apollo Server execution + GraphQL parsing + `@ResolveField` dispatch on top of the same business logic. It does **not** include network/transport costs that would differ in a real-world deployment.
- Each REST endpoint projects its response to the exact field set the matching GraphQL query selects (including mirroring GraphQL `ID`-scalar fields as strings, emitting selected-but-null fields, and resolving `assignee` only where the selection asks). Verified byte-identical per op (list/byId/create/merge) modulo GraphQL's `{"data":{…}}` envelope (~20 bytes), so payload encode/decode cost is equal on both sides.
- Numbers fluctuate ±5–10% across runs on M-series Macs because of thermal throttling. Always re-measure on the target hardware.
