# Benchmark findings

Narrative analysis kept out of `BENCHMARK.md`, which is regenerated wholesale by
`bun run bench:matrix` and would lose anything written into it by hand.

## Why GraphQL on `bun` trails `express` (investigated 2026-07-27)

At medium/large load on Bun 1.3.5/1.4.0-canary the `graphql-nest-bun` target sat
~2–3% *behind* `graphql-nest-express`, while `rest-nest-bun` led REST by ~8–20%.
The cause is the **driver integration path, not the adapter**.

> On the released Bun 1.4.0 (2026-08-20) the GraphQL gap no longer reproduces —
> against `express` `bun` lands at −1.6% (small), +1.8% (medium), +0.8% (large),
> i.e. level within run-to-run noise. (The standings table further down compares
> against the *better* of the two rivals, so its GraphQL row reads slightly
> differently for medium.) The structural finding below is unchanged:
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

Re-measured on the released Bun 1.4.0 (2026-08-20, `BENCHMARK-yoga-1.4.0.md`) the
bridge cost is unchanged in kind and smaller in size than the July k6 figure
(medium +71.9% → +54.4%, because Apollo-on-bun itself got faster): Yoga is +58.4% /
+54.4% / +56.9% over Apollo-on-bun at small/medium/large, and +55.0% over
Apollo-on-express at medium (4944 vs 3190). The gap holds its shape across the
runtime upgrade, which is what the bridge explanation predicts: the cost sits in
`@as-integrations/express5`, not in anything 1.4.0 changed.

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

Measured on the **released** 1.4.0 against a 1.3.5 baseline on the same host and
the same adapter code: `BENCHMARK.md` (1.4.0, 2026-08-20) and
`BENCHMARK-1.3.5-2026-08-21.md` (1.3.5, run under a `bun@1.3.5` binary from npm).

Every target gained, and **the `node:http` frameworks gained roughly half again
as much as we did** — 1.4.0 rewrote the compatibility layer `express`/`fastify`
ride on, and our fetch-native path never used it:

| load | target | 1.3.5 | 1.4.0 | Δ RPS | Δ p99 |
| --- | --- | ---: | ---: | ---: | ---: |
| REST large | `rest-nest-bun` | 13 081 | 16 210 | +23.9% | −17.6% |
| REST large | `rest-nest-fastify` | 10 917 | 15 123 | **+38.5%** | −36.2% |
| REST large | `rest-nest-express` | 10 270 | 14 021 | **+36.5%** | −37.4% |
| GraphQL large | `graphql-nest-bun` | 2 693 | 3 402 | +26.3% | −3.4% |
| GraphQL large | `graphql-nest-fastify` | 2 518 | 3 317 | +31.7% | −35.0% |
| GraphQL large | `graphql-nest-express` | 2 541 | 3 374 | +32.8% | −45.0% |

So the adapter's lead narrowed — it did not disappear on REST, and it did
disappear on GraphQL:

| | REST 1.3.5 | REST 1.4.0 | GraphQL 1.3.5 | GraphQL 1.4.0 |
| --- | ---: | ---: | ---: | ---: |
| small | +7.7% | +8.4% | +6.5% | −1.6% |
| medium | +10.7% | +6.3% | +2.1% | +0.8% |
| large | **+19.8%** | **+7.2%** | +6.0% | +0.8% |

(lead of `*-nest-bun` over the better of `express`/`fastify`.)

Memory is the one axis where the gap did not move our way: `rest-nest-bun` RSS
avg at large load went 212.1 → 223.9 MB while `fastify` fell 288.8 → 271.9 and
`express` 261.7 → 255.9. We are still the leanest by ~30–50 MB, but 1.4.0 spent
some of our advantage.

**On the measurement.** The two matrices come from different sessions, so a
same-session paired control was run last (REST, 100 VUs × 15 s, the two runtimes
back to back): `bun` 12 918 → 15 759 (+22.0%), `fastify` 11 034 → 14 895
(+35.0%), `express` 10 288 → 13 283 (+29.1%), lead +17.1% → +5.8%. That
reproduces the table above within a couple of points, including the ordering of
who gained most.

A same-session 1.4.0 matrix was also run and **discarded**: worst-cell stddev
21.9% against 4.5% for the matrix actually used, because desktop load (a VPN
client pinning a core) drifted through it. Numbers that noisy cannot resolve a
10% runtime difference — re-run on an idle machine before trusting any figure
with a band that wide.

The earlier 1.4.0-canary preview (2026-07-26, `BENCHMARK-1.4.0-canary.md` with
`BENCHMARK-1.3.5-control.md` beside it) called the same shape from a prerelease:
REST lead +19.1% → +7.3% at large. It is kept for the record.
