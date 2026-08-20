# Benchmark findings

Narrative analysis kept out of `BENCHMARK.md`, which is regenerated wholesale by
`bun run bench:matrix` and would lose anything written into it by hand.

## Why GraphQL on `bun` trails `express` (investigated 2026-07-27)

At medium/large load on Bun 1.3.5/1.4.0-canary the `graphql-nest-bun` target sat
~2–3% *behind* `graphql-nest-express`, while `rest-nest-bun` led REST by ~8–20%.
The cause is the **driver integration path, not the adapter**.

> On the released Bun 1.4.0 (2026-08-20) the GraphQL gap no longer reproduces —
> `bun` lands at −1.6% (small), +1.8% (medium), +0.8% (large) against `express`,
> i.e. level within run-to-run noise. The structural finding below is unchanged:
> Apollo reaches the adapter through the Express bridge, and Yoga on the same
> adapter is far faster than either.

`@nestjs/apollo` selects its integration from `httpAdapter.getType()`, and maps
`'bun'` onto the Express one:

```js
// @nestjs/apollo/dist/drivers/apollo.driver.js
if (platformName === 'express')      await this.registerExpress(apolloOptions);
else if (platformName === 'bun')     await this.registerExpress(apolloOptions);
else if (platformName === 'fastify') await this.registerFastify(apolloOptions);
```

So Apollo talks to `BunHttpAdapter` through `@as-integrations/express5` against
our Node-shaped `req`/`res` shims. `fastify` gets a native integration; we share
`express`'s, plus a shim layer.

Evidence that the adapter core is not the bottleneck (Bun 1.4.0-canary, medium,
k6, 50 VUs × 10s):

| target | RPS | p99 (ms) |
| --- | ---: | ---: |
| `graphql-nest-bun` (Apollo via the Express bridge) | 2877 | 55.9 |
| `graphql-nest-express` | 3210 | 29.9 |
| **`graphql-nest-bun-yoga`** (fetch-native, same adapter) | **4944** | **19.1** |

Yoga on the *same* `BunHttpAdapter` is +71.9% over Apollo-on-bun and +54% over
Apollo-on-express — it bypasses the `req`/`res` bridge and takes the raw Web
`Request`.

Two hypotheses that were measured and **rejected**:

- *"Apollo's two `use()` calls disable the native-routes fast path, and the manual
  `fetch` dispatcher is the cost."* A REST target with two equivalent no-op
  middlewares registered scored 14 895 RPS vs 15 085 without — **−1.3%**. The
  dispatcher is not the problem. (`rest-nest-bun` also beats `rest-nest-express`
  by +20.2% using the very same shims.)
- *"`urlParse(req.url)` in `expressMiddleware` is hot."* `bun --cpu-prof` blamed
  `node:url parse` for 7.97% of CPU. Instrumenting the call in the running app
  measured **31 997 calls totalling 11.7 ms — 0.08%**, 365 ns/call. Frame-level
  attribution from the sampling profiler is unreliable on this async-heavy path;
  verify any hot frame with direct instrumentation before acting on it.

CPU profile by category (both targets, under k6): `graphql` + `@apollo/server`
account for ~43% on each side; adapter code in `src/` is **4.24%** with no hot
spot (largest single frame `dispatchRoutes`, 2.42%).

> `graphql-nest-bun-yoga` is bench-only tooling, not part of the published
> adapter. It is diagnostic evidence that the bridge costs ~40–70%, not a
> recommendation to change the adapter's GraphQL story.

## Bun 1.4.0 — what the runtime upgrade did to the standings

Bun 1.4.0 shipped final on 2026-08-20 and is now the pinned CI runtime; `BENCHMARK.md`
was regenerated against it on the same host as the 2026-07-26 canary session.

**The canary preview held.** Bun 1.4.0 speeds up the `node:http` compatibility layer
that `express`/`fastify` depend on more than it speeds up our fetch-native path, so
every target gained and **the adapter's relative REST lead narrowed** — but it did
not disappear.

Lead of `rest-nest-bun` over the best rival (`fastify`). The first two columns are
the same session and the same code; the third is today's regeneration, so read it as
a standings check rather than a controlled A/B:

| size | 1.3.5 (2026-07-26) | 1.4.0-canary (2026-07-26) | 1.4.0 released (2026-08-20) |
| --- | ---: | ---: | ---: |
| small | +5.7% | +7.1% | +8.4% |
| medium | +10.5% | +8.0% | +6.3% |
| large | +19.1% | +7.3% | +7.2% |

Released-1.4.0 totals at large load (100 conn × 15s): `rest-nest-bun` 16 210 RPS /
p99 11.2 ms / RSS avg 223.9 MB, `rest-nest-fastify` 15 123 / 12.0 / 271.9,
`rest-nest-express` 14 021 / 12.9 / 255.9. The memory gap is the part the runtime
upgrade did *not* erode — the adapter still runs ~30–50 MB leaner than both rivals
at every load size, because there is no `node:http` object graph per request.

Absolute RPS is higher across the board than in the July session (e.g. `rest-nest-bun`
large 13 410 → 16 210), but that number mixes three things: the runtime, the adapter
changes committed since 2026-07-27, and machine state. Only the within-session ratios
above compare cleanly.

Raw matrices: `BENCHMARK.md` (released 1.4.0), `BENCHMARK-1.4.0-canary.md`,
`BENCHMARK-1.3.5-control.md`.
