# Benchmarks

Two benchmark harnesses live under `tests/bench/`:

- **Single-route HTTP** (`bun-bench.ts`) — raw `GET /` throughput for
  bun / express / fastify and the Nest variants. Summarised in the top-level
  [`README.md`](../README.md).
- **GraphQL-vs-REST matrix** (`run-matrix.ts`) — the same NestJS app exercised
  over GraphQL and REST on each adapter, across load sizes. Writes
  [`BENCHMARK.md`](../BENCHMARK.md).

## Commands

```bash
bun run bench           # single-route HTTP, 30s × 50 connections
bun run bench:quick     # single-route HTTP, 5s × 50 connections
bun run bench:rest      # REST cross-adapter via k6 (one run)
bun run bench:matrix    # full GraphQL+REST matrix → regenerates BENCHMARK.md
# Apollo-vs-Yoga-on-bun section:
bun run tests/bench/run-matrix.ts --with-yoga
```

`bench:rest` / `bench:matrix` require **k6** on `PATH` (`brew install k6`);
`bench` does not.

## Methodology (why the numbers are trustworthy)

- **External load generator.** Both REST and GraphQL load is driven by an
  external **k6** process (Go, multi-threaded). An in-process Bun `fetch` client
  co-located with a Bun server contends for the same single-threaded JSC runtime
  and *under-reports the bun target*; node-based express/fastify don't share the
  runtime, so they aren't penalised. k6 removes that bias. (For REST this flips
  the headline result; for GraphQL the effect is within noise because
  per-request server work dominates — but k6 is used for both so a single
  instrument measures every target.)
- **Byte-parity payloads.** Each REST endpoint projects its response to the
  exact field set the matching GraphQL query selects — including serialising
  `@IDField`/`ID`-scalar fields as strings and emitting selected-but-null
  fields — so REST and GraphQL responses are byte-identical per op (modulo the
  GraphQL `{"data":{…}}` envelope). Encode/decode cost is equal on both sides.
- **Server RSS** is sampled by polling `ps -o rss=` against the target child
  during the measurement window only (warmup excluded). k6 only drives traffic.
- **Port hygiene.** Runners reclaim the listen socket (`ensurePortFree`) before
  each spawn, so a slow teardown under load can't poison later trials.

## Operation mix

A weighted 100-entry table, identical for REST and GraphQL:

| op | weight |
| --- | ---: |
| list | 50% |
| byId | 25% |
| create | 15% |
| merge | 10% |

## Caveats

Numbers fluctuate ±5–10 % across runs on M-series Macs due to thermal
throttling, and are specific to the hardware / Bun / Nest versions used. Always
re-measure on your target. The in-process harnesses (`graphql-bench.ts`,
`rest-bench.ts`) are kept only for bun-vs-bun A/B, where both sides share the
same client slot.
