# NestJS Bun Adapter — GraphQL vs REST Benchmark

Generated 2026-08-21 09:33:21 UTC.

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
| graphql-nest-express | 2548 ± 65 _(2455..2648)_ | 6.7 ± 0.2 | 21.6 ± 1.0 | 303.7 ± 3.6 | 322.0 | 322.0 | 0 |
| graphql-nest-fastify | 2542 ± 67 _(2439..2610)_ | 6.6 ± 0.1 | 22.2 ± 0.8 | 289.8 ± 2.8 | 310.9 | 310.9 | 0 |
| **graphql-nest-bun** | 2713 ± 28 _(2671..2746)_ | 7.0 ± 0.1 | 22.2 ± 0.3 | 279.6 ± 2.6 | 294.9 | 294.9 | 0 |

### REST (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| rest-nest-express | 11571 ± 250 _(11243..11931)_ | 1.3 ± 0.0 | 5.4 ± 0.2 | 231.7 ± 4.0 | 241.9 | 241.9 | 0 |
| rest-nest-fastify | 12660 ± 152 _(12426..12853)_ | 1.2 ± 0.0 | 4.7 ± 0.1 | 235.7 ± 1.9 | 258.8 | 258.8 | 0 |
| **rest-nest-bun** | 13638 ± 175 _(13367..13804)_ | 1.4 ± 0.0 | 3.5 ± 0.1 | 223.2 ± 4.7 | 244.7 | 244.7 | 0 |

### small — GraphQL tax (same adapter, REST as baseline)

`Δ RPS` = `(GraphQL − REST) / REST` (negative = GraphQL slower); `Δ p99` likewise. `Δ RSS` is GraphQL minus REST in MB. 

| adapter | REST RPS | GraphQL RPS | Δ RPS | REST p99 | GraphQL p99 | Δ p99 | REST RSS | GraphQL RSS | Δ RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 11571 | 2548 | -78.0% | 5.4 | 21.6 | +300.0% | 231.7 | 303.7 | +72.0 |
| fastify | 12660 | 2542 | -79.9% | 4.7 | 22.2 | +372.0% | 235.7 | 289.8 | +54.1 |
| **bun** | 13638 | 2713 | -80.1% | 3.5 | 22.2 | +527.3% | 223.2 | 279.6 | +56.4 |

## Medium load (50 conn × 10s)

### GRAPHQL (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| graphql-nest-express | 2593 ± 47 _(2533..2646)_ | 19.1 ± 0.3 | 40.7 ± 1.5 | 301.3 ± 15.0 | 322.6 | 323.2 | 0 |
| graphql-nest-fastify | 2525 ± 34 _(2465..2554)_ | 19.7 ± 0.3 | 40.7 ± 0.8 | 330.2 ± 2.7 | 367.0 | 367.5 | 0 |
| **graphql-nest-bun** | 2647 ± 37 _(2590..2698)_ | 18.7 ± 0.2 | 35.9 ± 1.0 | 295.2 ± 15.2 | 321.5 | 323.0 | 0 |

### REST (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| rest-nest-express | 10859 ± 245 _(10467..11083)_ | 4.7 ± 0.1 | 10.9 ± 0.4 | 234.5 ± 10.0 | 251.8 | 254.1 | 0 |
| rest-nest-fastify | 11632 ± 484 _(10685..12015)_ | 4.4 ± 0.1 | 10.2 ± 1.1 | 267.2 ± 15.8 | 296.7 | 297.3 | 0 |
| **rest-nest-bun** | 12872 ± 203 _(12646..13185)_ | 3.7 ± 0.0 | 7.7 ± 0.4 | 238.7 ± 11.4 | 260.1 | 260.8 | 0 |

### medium — GraphQL tax (same adapter, REST as baseline)

`Δ RPS` = `(GraphQL − REST) / REST` (negative = GraphQL slower); `Δ p99` likewise. `Δ RSS` is GraphQL minus REST in MB. 

| adapter | REST RPS | GraphQL RPS | Δ RPS | REST p99 | GraphQL p99 | Δ p99 | REST RSS | GraphQL RSS | Δ RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 10859 | 2593 | -76.1% | 10.9 | 40.7 | +273.7% | 234.5 | 301.3 | +66.8 |
| fastify | 11632 | 2525 | -78.3% | 10.2 | 40.7 | +299.6% | 267.2 | 330.2 | +63.0 |
| **bun** | 12872 | 2647 | -79.4% | 7.7 | 35.9 | +363.7% | 238.7 | 295.2 | +56.5 |

## Large load (100 conn × 15s)

### GRAPHQL (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| graphql-nest-express | 2541 ± 40 _(2487..2601)_ | 39.2 ± 0.5 | 80.7 ± 2.9 | 305.1 ± 20.7 | 327.9 | 328.6 | 0 |
| graphql-nest-fastify | 2518 ± 66 _(2445..2629)_ | 39.7 ± 1.0 | 84.2 ± 5.0 | 319.6 ± 18.5 | 346.2 | 347.7 | 0 |
| **graphql-nest-bun** | 2693 ± 40 _(2642..2747)_ | 36.3 ± 0.3 | 55.7 ± 8.9 | 285.7 ± 18.5 | 311.9 | 312.4 | 0 |

### REST (5 runs)

| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| rest-nest-express | 10270 ± 109 _(10188..10481)_ | 10.2 ± 0.1 | 20.6 ± 0.8 | 261.7 ± 17.5 | 287.8 | 289.0 | 0 |
| rest-nest-fastify | 10917 ± 170 _(10582..11033)_ | 9.6 ± 0.1 | 18.8 ± 0.9 | 288.8 ± 14.7 | 319.6 | 321.7 | 0 |
| **rest-nest-bun** | 13081 ± 186 _(12814..13312)_ | 7.3 ± 0.1 | 13.6 ± 0.3 | 212.1 ± 11.5 | 237.6 | 240.8 | 0 |

### large — GraphQL tax (same adapter, REST as baseline)

`Δ RPS` = `(GraphQL − REST) / REST` (negative = GraphQL slower); `Δ p99` likewise. `Δ RSS` is GraphQL minus REST in MB. 

| adapter | REST RPS | GraphQL RPS | Δ RPS | REST p99 | GraphQL p99 | Δ p99 | REST RSS | GraphQL RSS | Δ RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| express | 10270 | 2541 | -75.3% | 20.6 | 80.7 | +292.5% | 261.7 | 305.1 | +43.4 |
| fastify | 10917 | 2518 | -76.9% | 18.8 | 84.2 | +347.0% | 288.8 | 319.6 | +30.8 |
| **bun** | 13081 | 2693 | -79.4% | 13.6 | 55.7 | +310.9% | 212.1 | 285.7 | +73.7 |

## Findings

Narrative analysis that outlives a regeneration — why GraphQL on `bun` trails `express`, and how the Bun 1.4.0 upgrade moved the standings — lives in [`BENCHMARK-FINDINGS.md`](./BENCHMARK-FINDINGS.md).

## Notes

- All load is driven by an external **k6** process so the generator never shares a runtime or cores with the server under test. An in-process Bun `fetch` client systematically under-reports the bun target because client and server contend for the same single-threaded JSC runtime; k6 removes that bias. For REST this flips the headline result; for GraphQL the effect is within noise (per-request server work dominates), but k6 is used for both so a single instrument measures every target.
- RSS is captured by polling `ps -o rss= -p <pid>` every 250 ms during the measurement window only (warmup excluded so JIT/heap growth does not skew the idle baseline).
- Idle RSS is sampled once right after the target becomes ready, before warmup and traffic.
- The "GraphQL tax" reflects the cost of `@nestjs/apollo` + Apollo Server execution + GraphQL parsing + `@ResolveField` dispatch on top of the same business logic. It does **not** include network/transport costs that would differ in a real-world deployment.
- Each REST endpoint projects its response to the exact field set the matching GraphQL query selects (including mirroring GraphQL `ID`-scalar fields as strings, emitting selected-but-null fields, and resolving `assignee` only where the selection asks). Verified byte-identical per op (list/byId/create/merge) modulo GraphQL's `{"data":{…}}` envelope (~20 bytes), so payload encode/decode cost is equal on both sides.
- Numbers fluctuate ±5–10% across runs on M-series Macs because of thermal throttling. Always re-measure on the target hardware.
