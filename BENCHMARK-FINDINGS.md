# Benchmark findings

Narrative analysis kept out of `BENCHMARK.md`, which is regenerated wholesale by
`bun run bench:matrix` and would lose anything written into it by hand.

## Why GraphQL on `bun` trails `express` (investigated 2026-07-27)

At medium/large load the `graphql-nest-bun` target sits ~2–3% *behind*
`graphql-nest-express`, while `rest-nest-bun` leads REST by ~8–20%. The cause is
the **driver integration path, not the adapter**.

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

## Bun 1.4.0-canary (measured 2026-07-26/27, not a released runtime)

Full matrix re-run on Bun 1.4.0-canary with a same-code 1.3.5 control in the same
session. Every target gained; **the adapter's relative lead narrowed**, because
Bun 1.4.0 speeds up the `node:http` compatibility layer that `express`/`fastify`
depend on more than it speeds up our fetch-native path.

| size | target | 1.3.5 | 1.4.0 | Δ |
| --- | --- | ---: | ---: | ---: |
| large | `rest-nest-bun` | 13 410 | 14 597 | +8.9% |
| large | `rest-nest-express` | 10 635 | 12 895 | +21.3% |
| large | `rest-nest-fastify` | 11 259 | 13 609 | +20.9% |

Lead of `rest-nest-bun` over the best rival at large load: **+19.1% on 1.3.5 →
+7.3% on 1.4.0**. On GraphQL at medium/large, `express` moves ahead by ~2.3%.

The same-code 1.3.5 control also reproduced the committed numbers above
(`rest-nest-bun` large: 13 410 vs 13 212), confirming this table remains valid for
the pinned runtime and that the adapter changes shipped since 2026-06-09 cost no
throughput.

Raw matrices: `BENCHMARK-1.4.0-canary.md`, `BENCHMARK-1.3.5-control.md`.

