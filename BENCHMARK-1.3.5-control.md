# NestJS Bun Adapter — GraphQL vs REST Benchmark

Generated 2026-07-26 20:32:04 UTC.

## Environment

- **Host**: MacBook-Pro-Taras.local (darwin 25.3.0)  
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
| graphql-nest-express | 2660 ± 72 _(2571..2770)_ | 6.6 ± 0.2 | 19.9 ± 0.6 | 307.4 ± 3.1 | 325.7 | 325.7 | 0 |
| graphql-nest-fastify | 2630 ± 71 _(2530..2745)_ | 6.4 ± 0.2 | 21.1 ± 0.6 | 294.1 ± 1.7 | 318.9 | 318.9 | 0 |
| **graphql-nest-bun** | 2879 ± 43 _(2811..2925)_ | 6.4 ± 0.1 | 20.4 ± 0.3 | 279.3 ± 2.1 | 294.9 | 294.9 | 0 |

### REST (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| rest-nest-express | 11661 ± 39 _(11584..11693)_ | 1.4 ± 0.0 | 5.2 ± 0.0 | 237.7 ± 0.4 | 246.1 | 246.1 | 0 |
| rest-nest-fastify | 12641 ± 70 _(12584..12774)_ | 1.2 ± 0.0 | 4.8 ± 0.1 | 238.7 ± 1.1 | 257.6 | 257.6 | 0 |
| **rest-nest-bun** | 13359 ± 41 _(13312..13425)_ | 1.4 ± 0.0 | 3.7 ± 0.0 | 222.3 ± 4.9 | 240.5 | 240.5 | 0 |

### small — GraphQL tax (same adapter, REST as baseline)

`Δ RPS` = `(GraphQL − REST) / REST` (negative = GraphQL slower); `Δ p99` likewise. `Δ RSS` is GraphQL minus REST in MB. 

| adapter | REST RPS | GraphQL RPS | Δ RPS | REST p99 | GraphQL p99 | Δ p99 | REST RSS | GraphQL RSS | Δ RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 11661 | 2660 | -77.2% | 5.2 | 19.9 | +285.3% | 237.7 | 307.4 | +69.7 |
| fastify | 12641 | 2630 | -79.2% | 4.8 | 21.1 | +337.8% | 238.7 | 294.1 | +55.4 |
| **bun** | 13359 | 2879 | -78.4% | 3.7 | 20.4 | +451.0% | 222.3 | 279.3 | +57.0 |

## Medium load (50 conn × 10s)

### GRAPHQL (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| graphql-nest-express | 2764 ± 56 _(2696..2838)_ | 17.9 ± 0.4 | 37.6 ± 0.9 | 329.1 ± 3.2 | 334.0 | 334.0 | 0 |
| graphql-nest-fastify | 2667 ± 14 _(2647..2688)_ | 18.6 ± 0.1 | 38.5 ± 0.3 | 335.5 ± 1.4 | 370.1 | 370.9 | 0 |
| **graphql-nest-bun** | 2842 ± 60 _(2749..2918)_ | 17.4 ± 0.4 | 33.4 ± 0.7 | 310.8 ± 1.2 | 328.7 | 328.7 | 0 |

### REST (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| rest-nest-express | 11304 ± 407 _(10750..11761)_ | 4.5 ± 0.2 | 10.3 ± 0.5 | 264.2 ± 7.1 | 286.3 | 286.4 | 0 |
| rest-nest-fastify | 12023 ± 347 _(11612..12407)_ | 4.3 ± 0.1 | 9.5 ± 0.3 | 275.8 ± 10.2 | 306.9 | 307.4 | 0 |
| **rest-nest-bun** | 13283 ± 416 _(12843..13817)_ | 3.7 ± 0.1 | 7.2 ± 0.3 | 249.4 ± 5.2 | 267.5 | 267.6 | 0 |

### medium — GraphQL tax (same adapter, REST as baseline)

`Δ RPS` = `(GraphQL − REST) / REST` (negative = GraphQL slower); `Δ p99` likewise. `Δ RSS` is GraphQL minus REST in MB. 

| adapter | REST RPS | GraphQL RPS | Δ RPS | REST p99 | GraphQL p99 | Δ p99 | REST RSS | GraphQL RSS | Δ RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 11304 | 2764 | -75.5% | 10.3 | 37.6 | +265.6% | 264.2 | 329.1 | +64.9 |
| fastify | 12023 | 2667 | -77.8% | 9.5 | 38.5 | +303.2% | 275.8 | 335.5 | +59.7 |
| **bun** | 13283 | 2842 | -78.6% | 7.2 | 33.4 | +366.6% | 249.4 | 310.8 | +61.4 |

## Large load (100 conn × 15s)

### GRAPHQL (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| graphql-nest-express | 2652 ± 55 _(2575..2716)_ | 37.7 ± 0.7 | 76.5 ± 2.4 | 318.3 ± 13.6 | 337.5 | 337.5 | 0 |
| graphql-nest-fastify | 2617 ± 48 _(2565..2702)_ | 38.2 ± 0.7 | 78.0 ± 1.2 | 354.6 ± 2.0 | 374.0 | 374.4 | 0 |
| **graphql-nest-bun** | 2804 ± 68 _(2723..2883)_ | 35.3 ± 0.9 | 42.2 ± 1.3 | 321.9 ± 2.7 | 334.3 | 334.4 | 0 |

### REST (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| rest-nest-express | 10635 ± 83 _(10531..10760)_ | 9.9 ± 0.1 | 19.2 ± 0.1 | 293.4 ± 7.6 | 326.5 | 330.2 | 0 |
| rest-nest-fastify | 11259 ± 63 _(11181..11351)_ | 9.3 ± 0.1 | 18.0 ± 0.1 | 310.8 ± 8.0 | 340.6 | 343.2 | 0 |
| **rest-nest-bun** | 13410 ± 28 _(13367..13443)_ | 7.2 ± 0.1 | 12.3 ± 0.9 | 265.6 ± 5.6 | 292.0 | 293.8 | 0 |

### large — GraphQL tax (same adapter, REST as baseline)

`Δ RPS` = `(GraphQL − REST) / REST` (negative = GraphQL slower); `Δ p99` likewise. `Δ RSS` is GraphQL minus REST in MB. 

| adapter | REST RPS | GraphQL RPS | Δ RPS | REST p99 | GraphQL p99 | Δ p99 | REST RSS | GraphQL RSS | Δ RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 10635 | 2652 | -75.1% | 19.2 | 76.5 | +298.4% | 293.4 | 318.3 | +25.0 |
| fastify | 11259 | 2617 | -76.8% | 18.0 | 78.0 | +333.8% | 310.8 | 354.6 | +43.8 |
| **bun** | 13410 | 2804 | -79.1% | 12.3 | 42.2 | +242.7% | 265.6 | 321.9 | +56.3 |

## Notes

- All load is driven by an external **k6** process so the generator never shares a runtime or cores with the server under test. An in-process Bun `fetch` client systematically under-reports the bun target because client and server contend for the same single-threaded JSC runtime; k6 removes that bias. For REST this flips the headline result; for GraphQL the effect is within noise (per-request server work dominates), but k6 is used for both so a single instrument measures every target.
- RSS is captured by polling `ps -o rss= -p <pid>` every 250 ms during the measurement window only (warmup excluded so JIT/heap growth does not skew the idle baseline).
- Idle RSS is sampled once right after the target becomes ready, before warmup and traffic.
- The "GraphQL tax" reflects the cost of `@nestjs/apollo` + Apollo Server execution + GraphQL parsing + `@ResolveField` dispatch on top of the same business logic. It does **not** include network/transport costs that would differ in a real-world deployment.
- Each REST endpoint projects its response to the exact field set the matching GraphQL query selects (including mirroring GraphQL `ID`-scalar fields as strings, emitting selected-but-null fields, and resolving `assignee` only where the selection asks). Verified byte-identical per op (list/byId/create/merge) modulo GraphQL's `{"data":{…}}` envelope (~20 bytes), so payload encode/decode cost is equal on both sides.
- Numbers fluctuate ±5–10% across runs on M-series Macs because of thermal throttling. Always re-measure on the target hardware.
