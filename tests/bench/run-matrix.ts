/**
 * Matrix runner: runs `graphql-bench.ts` AND `rest-bench.ts` over
 * {small, medium, large} load sizes × N runs each, then aggregates per
 * (size, protocol, target) and writes a markdown report.
 *
 * Both benchmarks hit the same `TodoItemService` / `TodoItemDTO` / CASL
 * permissions / ValidationPipe — only the protocol differs — so the
 * cross-protocol delta is a fair measurement of GraphQL/Apollo overhead.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const TMP_DIR = join(ROOT, '.bench-runs');

type Protocol = 'graphql' | 'rest';
const PROTOCOLS: readonly Protocol[] = ['graphql', 'rest'];

// Both protocols are driven by an external k6 process (Go, multi-threaded), not
// an in-process Bun `fetch` client. A co-located single-threaded bun-fetch
// generator contends with a Bun server for the same runtime/cores and
// under-reports the bun target; k6 removes that bias. Using k6 for GraphQL too
// (where the effect is small) keeps one instrument and removes the asymmetry.
// The in-process `graphql-bench.ts` / `rest-bench.ts` stay for bun-vs-bun A/B.
const BENCH_FILE: Record<Protocol, string> = {
  graphql: join(import.meta.dir, 'graphql-bench-k6.ts'),
  rest: join(import.meta.dir, 'rest-bench-k6.ts'),
};

type AdapterName = 'express' | 'fastify' | 'bun';
const ADAPTERS: readonly AdapterName[] = ['express', 'fastify', 'bun'];

const TARGET_BY = (protocol: Protocol, adapter: AdapterName) =>
  `${protocol}-nest-${adapter}` as const;

const OP_KINDS = ['list', 'byId', 'create', 'merge'] as const;
type OpKind = (typeof OP_KINDS)[number];

interface SizeCfg {
  name: 'small' | 'medium' | 'large';
  connections: number;
  duration: number;
  warmup: number;
}

const SIZES: readonly SizeCfg[] = [
  { name: 'small', connections: 20, duration: 5, warmup: 1 },
  { name: 'medium', connections: 50, duration: 10, warmup: 2 },
  { name: 'large', connections: 100, duration: 15, warmup: 3 },
] as const;

interface OpResult {
  ok: number;
  errors: number;
  rps: number;
  latencyAvg: number;
  latencyP50: number;
  latencyP90: number;
  latencyP99: number;
  throughputBps: number;
}

interface MemStats {
  idleBytes: number;
  minBytes: number;
  avgBytes: number;
  maxBytes: number;
  p95Bytes: number;
  samples: number;
}

interface TargetResult {
  byOp: Record<OpKind, OpResult>;
  total: OpResult;
  durationMs: number;
  mem: MemStats;
}

interface BenchOutput {
  args: {
    connections: number;
    duration: number;
    warmupSec: number;
    memSampleMs: number;
  };
  bunVersion: string;
  timestamp: string;
  results: Record<string, TargetResult>;
}

interface MatrixArgs {
  runs: number;
  output: string;
  protocols: Protocol[];
  withYoga: boolean;
}

// Experimental extra GraphQL target: Yoga driver on bun (vs Apollo on bun).
// Rendered in its own section, kept out of the 3-adapter tables / GraphQL tax.
const YOGA_TARGET = 'graphql-nest-bun-yoga';
const GRAPHQL_TARGETS_WITH_YOGA = [
  'graphql-nest-express',
  'graphql-nest-fastify',
  'graphql-nest-bun',
  YOGA_TARGET,
].join(',');

function parseMatrixArgs(argv: string[]): MatrixArgs {
  const args: MatrixArgs = {
    runs: 5,
    output: join(ROOT, 'BENCHMARK.md'),
    protocols: [...PROTOCOLS],
    withYoga: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--runs') args.runs = Math.max(1, Number(argv[++i]) || args.runs);
    else if (t === '--output' || t === '-o') args.output = argv[++i] ?? args.output;
    else if (t === '--with-yoga') args.withYoga = true;
    else if (t === '--protocols') {
      const raw = argv[++i] ?? '';
      const list = raw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean) as Protocol[];
      const bad = list.filter(p => !PROTOCOLS.includes(p));
      if (bad.length) throw new Error(`unknown protocol(s): ${bad.join(', ')}`);
      args.protocols = list;
    } else if (t === '-h' || t === '--help') {
      console.log(
        'Usage: bun run tests/bench/run-matrix.ts [--runs N] [--output PATH] [--protocols graphql,rest] [--with-yoga]',
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${t}`);
  }
  return args;
}

function runBench(
  protocol: Protocol,
  size: SizeCfg,
  runIndex: number,
  withYoga = false,
): Promise<BenchOutput> {
  return new Promise((resolve, reject) => {
    if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
    const tmp = join(TMP_DIR, `${protocol}-${size.name}-${runIndex}.json`);
    if (existsSync(tmp)) unlinkSync(tmp);
    // For GraphQL with --with-yoga, run the extra Yoga-on-bun target alongside
    // the 3 default adapters so its results land in the same JSON.
    const onlyArgs =
      protocol === 'graphql' && withYoga ? ['--only', GRAPHQL_TARGETS_WITH_YOGA] : [];
    const child = spawn(
      'bun',
      [
        'run',
        BENCH_FILE[protocol],
        '-c',
        String(size.connections),
        '-d',
        String(size.duration),
        '--warmup',
        String(size.warmup),
        '--ready-timeout',
        '60000',
        ...onlyArgs,
        '--json-out',
        tmp,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.stdout?.resume();
    child.once('exit', code => {
      if (code !== 0) {
        return reject(
          new Error(`bench exit ${code}\n--- stderr ---\n${stderr.slice(0, 2000)}`),
        );
      }
      try {
        resolve(JSON.parse(readFileSync(tmp, 'utf8')) as BenchOutput);
      } catch (e) {
        reject(e);
      }
    });
    child.once('error', reject);
  });
}

const mean = (xs: number[]) =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
const stddev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map(x => (x - m) ** 2)));
};
const minOf = (xs: number[]) => (xs.length === 0 ? 0 : Math.min(...xs));
const maxOf = (xs: number[]) => (xs.length === 0 ? 0 : Math.max(...xs));

interface AggCell {
  mean: number;
  std: number;
  min: number;
  max: number;
  values: number[];
}

function aggCell(values: number[]): AggCell {
  return {
    mean: mean(values),
    std: stddev(values),
    min: minOf(values),
    max: maxOf(values),
    values,
  };
}

interface TargetAgg {
  totalRps: AggCell;
  totalP99: AggCell;
  totalP50: AggCell;
  rssAvg: AggCell;
  rssP95: AggCell;
  rssMax: AggCell;
  rssIdle: AggCell;
  errors: number;
  perOp: Record<OpKind, { rps: AggCell; p99: AggCell }>;
}

function aggregate(runs: BenchOutput[], target: string): TargetAgg {
  const get = (r: BenchOutput, path: (t: TargetResult) => number) => {
    const t = r.results[target];
    return t ? path(t) : 0;
  };
  const totalRps = runs.map(r => get(r, t => t.total?.rps ?? 0));
  const totalP99 = runs.map(r => get(r, t => t.total?.latencyP99 ?? 0));
  const totalP50 = runs.map(r => get(r, t => t.total?.latencyP50 ?? 0));
  const rssAvg = runs.map(r => get(r, t => t.mem?.avgBytes ?? 0));
  const rssP95 = runs.map(r => get(r, t => t.mem?.p95Bytes ?? 0));
  const rssMax = runs.map(r => get(r, t => t.mem?.maxBytes ?? 0));
  const rssIdle = runs.map(r => get(r, t => t.mem?.idleBytes ?? 0));
  const errors = runs.reduce(
    (sum, r) =>
      sum + OP_KINDS.reduce((s, k) => s + (r.results[target]?.byOp?.[k]?.errors ?? 0), 0),
    0,
  );
  const perOp = {} as Record<OpKind, { rps: AggCell; p99: AggCell }>;
  for (const k of OP_KINDS) {
    perOp[k] = {
      rps: aggCell(runs.map(r => r.results[target]?.byOp?.[k]?.rps ?? 0)),
      p99: aggCell(runs.map(r => r.results[target]?.byOp?.[k]?.latencyP99 ?? 0)),
    };
  }
  return {
    totalRps: aggCell(totalRps),
    totalP99: aggCell(totalP99),
    totalP50: aggCell(totalP50),
    rssAvg: aggCell(rssAvg),
    rssP95: aggCell(rssP95),
    rssMax: aggCell(rssMax),
    rssIdle: aggCell(rssIdle),
    errors,
    perOp,
  };
}

const fmt = (n: number, d = 0) => (Number.isFinite(n) && n > 0 ? n.toFixed(d) : '—');
const fmtMB = (b: number) =>
  Number.isFinite(b) && b > 0 ? `${(b / 1024 / 1024).toFixed(1)}` : '—';
const fmtPct = (a: number, b: number) => {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return '—';
  const p = ((a - b) / b) * 100;
  const sign = p >= 0 ? '+' : '';
  return `${sign}${p.toFixed(1)}%`;
};

interface RunsMatrix {
  [size: string]: { [protocol in Protocol]?: BenchOutput[] };
}

function buildMd(runs: RunsMatrix, matrixArgs: MatrixArgs): string {
  const lines: string[] = [];
  const firstRun =
    runs.medium?.graphql?.[0] ??
    runs.medium?.rest?.[0] ??
    runs.small?.graphql?.[0] ??
    runs.small?.rest?.[0];
  const bunVersion = firstRun?.bunVersion ?? '?';

  lines.push('# NestJS Bun Adapter — GraphQL vs REST Benchmark');
  lines.push('');
  lines.push(`Generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC.`);
  lines.push('');

  // ---- Environment ----
  lines.push('## Environment');
  lines.push('');
  lines.push(`- **Host**: ${hostname()} (${platform()} ${release()})  `);
  lines.push(`- **Total RAM**: ${(totalmem() / 1024 ** 3).toFixed(1)} GB  `);
  lines.push(`- **Bun**: ${bunVersion}  `);
  lines.push(`- **Runs per (size × protocol)**: ${matrixArgs.runs}  `);
  lines.push(`- **Protocols**: ${matrixArgs.protocols.join(', ')}  `);
  lines.push(
    '- **Load generator**: both REST and GraphQL driven by external **k6** (Go, multi-threaded) — the same instrument for every target.',
  );
  lines.push('');

  // ---- Workload ----
  lines.push('## Workload');
  lines.push('');
  lines.push(
    'Same `TodoItemService` (1000 seeded items, 50 users), same DTOs, same CASL `AccessGuard` + `@UseAbility(...)`, same global `ValidationPipe`. The only difference between targets is **how requests are dispatched**:',
  );
  lines.push('');
  lines.push(
    '- `graphql-nest-*` — `@nestjs/apollo` + `@nestjs/graphql` with a hand-written resolver. `assignee` is populated by `@ResolveField`.',
  );
  lines.push(
    '- `rest-nest-*` — plain `@Controller` mapping the same operations to REST verbs (GET/POST/PATCH). `assignee` is resolved by an explicit per-row lookup so the response payload mirrors what the GraphQL query selected.',
  );
  lines.push('');
  lines.push('Operation mix per request (weighted, 100-entry table):');
  lines.push('');
  lines.push('| op | weight | GraphQL | REST |');
  lines.push('| --- | ---: | --- | --- |');
  lines.push(
    '| list | 50% | `query todoItems(skip,take) { … }` | `GET /todo-items?skip&take` |',
  );
  lines.push('| byId | 25% | `query todoItem(id) { … }` | `GET /todo-items/:id` |');
  lines.push(
    '| create | 15% | `mutation createOneTodoItem(input)` | `POST /todo-items` |',
  );
  lines.push(
    '| merge | 10% | `mutation mergeTodoItem(id,input)` (Set/array/Map merges) | `PATCH /todo-items/:id/merge` (same merges) |',
  );
  lines.push('');

  // ---- Load sizes ----
  lines.push('## Load sizes');
  lines.push('');
  lines.push('| size | connections | duration | warmup |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const s of SIZES) {
    lines.push(`| ${s.name} | ${s.connections} | ${s.duration}s | ${s.warmup}s |`);
  }
  lines.push('');
  lines.push(
    'Each cell below is **mean ± stddev** across the runs. RPS rows show a `(min..max)` band so reproducibility is visible.',
  );
  lines.push('');

  // ---- Per-size sections ----
  for (const size of SIZES) {
    const sizeRuns = runs[size.name] ?? {};
    if ((sizeRuns.graphql?.length ?? 0) === 0 && (sizeRuns.rest?.length ?? 0) === 0) {
      continue;
    }
    lines.push(
      `## ${size.name[0].toUpperCase()}${size.name.slice(1)} load (${size.connections} conn × ${size.duration}s)`,
    );
    lines.push('');

    // Per-protocol summary
    for (const protocol of matrixArgs.protocols) {
      const protoRuns = sizeRuns[protocol] ?? [];
      if (protoRuns.length === 0) continue;
      lines.push(`### ${protocol.toUpperCase()} (${protoRuns.length} runs)`);
      lines.push('');
      lines.push(
        '| target | total RPS | p50 (ms) | p99 (ms) | RSS avg (MB) | RSS p95 (MB) | RSS max (MB) | errors |',
      );
      lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
      for (const adapter of ADAPTERS) {
        const target = TARGET_BY(protocol, adapter);
        const a = aggregate(protoRuns, target);
        const isBun = adapter === 'bun';
        const rpsBand = `${fmt(a.totalRps.mean, 0)} ± ${fmt(a.totalRps.std, 0)} _(${fmt(a.totalRps.min, 0)}..${fmt(a.totalRps.max, 0)})_`;
        const cells = [
          rpsBand,
          `${fmt(a.totalP50.mean, 1)} ± ${fmt(a.totalP50.std, 1)}`,
          `${fmt(a.totalP99.mean, 1)} ± ${fmt(a.totalP99.std, 1)}`,
          `${fmtMB(a.rssAvg.mean)} ± ${fmtMB(a.rssAvg.std)}`,
          fmtMB(a.rssP95.mean),
          fmtMB(a.rssMax.mean),
          String(a.errors),
        ];
        const name = isBun ? `**${target}**` : target;
        lines.push(`| ${name} | ${cells.join(' | ')} |`);
      }
      lines.push('');
    }

    // Cross-protocol GraphQL tax (only if both protocols ran)
    if (
      matrixArgs.protocols.includes('graphql') &&
      matrixArgs.protocols.includes('rest') &&
      (sizeRuns.graphql?.length ?? 0) > 0 &&
      (sizeRuns.rest?.length ?? 0) > 0
    ) {
      lines.push(`### ${size.name} — GraphQL tax (same adapter, REST as baseline)`);
      lines.push('');
      lines.push(
        '`Δ RPS` = `(GraphQL − REST) / REST` (negative = GraphQL slower); `Δ p99` likewise. `Δ RSS` is GraphQL minus REST in MB. ',
      );
      lines.push('');
      lines.push(
        '| adapter | REST RPS | GraphQL RPS | Δ RPS | REST p99 | GraphQL p99 | Δ p99 | REST RSS | GraphQL RSS | Δ RSS |',
      );
      lines.push(
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      );
      for (const adapter of ADAPTERS) {
        const restAgg = aggregate(sizeRuns.rest!, TARGET_BY('rest', adapter));
        const gqlAgg = aggregate(sizeRuns.graphql!, TARGET_BY('graphql', adapter));
        const memDelta = gqlAgg.rssAvg.mean - restAgg.rssAvg.mean;
        const memDeltaSign = memDelta >= 0 ? '+' : '';
        const isBun = adapter === 'bun';
        const name = isBun ? `**${adapter}**` : adapter;
        lines.push(
          `| ${name} | ${fmt(restAgg.totalRps.mean, 0)} | ${fmt(gqlAgg.totalRps.mean, 0)} | ${fmtPct(gqlAgg.totalRps.mean, restAgg.totalRps.mean)} | ${fmt(restAgg.totalP99.mean, 1)} | ${fmt(gqlAgg.totalP99.mean, 1)} | ${fmtPct(gqlAgg.totalP99.mean, restAgg.totalP99.mean)} | ${fmtMB(restAgg.rssAvg.mean)} | ${fmtMB(gqlAgg.rssAvg.mean)} | ${memDeltaSign}${fmtMB(Math.abs(memDelta))} |`,
        );
      }
      lines.push('');
    }
  }

  // ---- Apollo vs Yoga (bun) ----
  if (matrixArgs.withYoga) {
    const hasYoga = SIZES.some(s =>
      (runs[s.name]?.graphql ?? []).some(r => r.results[YOGA_TARGET]),
    );
    if (hasYoga) {
      lines.push('## GraphQL driver: Apollo vs Yoga (on bun)');
      lines.push('');
      lines.push(
        'Same hand-written resolver / service / DTOs / CASL — only the GraphQL **driver** differs. `graphql-nest-bun` uses `@nestjs/apollo` (ApolloDriver); `graphql-nest-bun-yoga` uses GraphQL Yoga via the experimental `BunYogaDriver` (fetch-native — feeds the raw Web `Request` to Yoga, no Node `req`/`res` bridge). Both run on `BunHttpAdapter`. `Δ` is Yoga relative to Apollo.',
      );
      lines.push('');
      lines.push(
        '| size | Apollo RPS | Yoga RPS | Δ RPS | Apollo p99 | Yoga p99 | Δ p99 | Apollo RSS | Yoga RSS |',
      );
      lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
      for (const size of SIZES) {
        const gqlRuns = runs[size.name]?.graphql ?? [];
        if (gqlRuns.length === 0 || !gqlRuns.some(r => r.results[YOGA_TARGET])) continue;
        const apollo = aggregate(gqlRuns, TARGET_BY('graphql', 'bun'));
        const yoga = aggregate(gqlRuns, YOGA_TARGET);
        lines.push(
          `| ${size.name} | ${fmt(apollo.totalRps.mean, 0)} | **${fmt(yoga.totalRps.mean, 0)}** | ${fmtPct(yoga.totalRps.mean, apollo.totalRps.mean)} | ${fmt(apollo.totalP99.mean, 1)} | ${fmt(yoga.totalP99.mean, 1)} | ${fmtPct(yoga.totalP99.mean, apollo.totalP99.mean)} | ${fmtMB(apollo.rssAvg.mean)} | ${fmtMB(yoga.rssAvg.mean)} |`,
        );
      }
      lines.push('');
      lines.push(
        '> `graphql-nest-bun-yoga` is experimental bench-only tooling (`tests/bench/frameworks/graphql/bun-yoga-driver.ts`), not part of the published adapter. Regenerate with `bun run tests/bench/run-matrix.ts --with-yoga`.',
      );
      lines.push('');
    }
  }

  // ---- Notes ----
  lines.push('## Notes');
  lines.push('');
  lines.push(
    '- All load is driven by an external **k6** process so the generator never shares a runtime or cores with the server under test. An in-process Bun `fetch` client systematically under-reports the bun target because client and server contend for the same single-threaded JSC runtime; k6 removes that bias. For REST this flips the headline result; for GraphQL the effect is within noise (per-request server work dominates), but k6 is used for both so a single instrument measures every target.',
  );
  lines.push(
    '- RSS is captured by polling `ps -o rss= -p <pid>` every 250 ms during the measurement window only (warmup excluded so JIT/heap growth does not skew the idle baseline).',
  );
  lines.push(
    '- Idle RSS is sampled once right after the target becomes ready, before warmup and traffic.',
  );
  lines.push(
    '- The "GraphQL tax" reflects the cost of `@nestjs/apollo` + Apollo Server execution + GraphQL parsing + `@ResolveField` dispatch on top of the same business logic. It does **not** include network/transport costs that would differ in a real-world deployment.',
  );
  lines.push(
    '- Each REST endpoint projects its response to the exact field set the matching GraphQL query selects (including mirroring GraphQL `ID`-scalar fields as strings, emitting selected-but-null fields, and resolving `assignee` only where the selection asks). Verified byte-identical per op (list/byId/create/merge) modulo GraphQL\'s `{"data":{…}}` envelope (~20 bytes), so payload encode/decode cost is equal on both sides.',
  );
  lines.push(
    '- Numbers fluctuate ±5–10% across runs on M-series Macs because of thermal throttling. Always re-measure on the target hardware.',
  );
  lines.push('');
  return lines.join('\n');
}

const main = async () => {
  const args = parseMatrixArgs(process.argv.slice(2));
  const totalTrials = SIZES.length * args.runs * args.protocols.length * ADAPTERS.length;
  console.log(
    `Matrix runner: ${SIZES.length} sizes × ${args.runs} runs × ${args.protocols.length} protocols × ${ADAPTERS.length} targets = ${totalTrials} trials\n`,
  );
  const runs: RunsMatrix = {};
  const tStart = Date.now();
  for (const size of SIZES) {
    runs[size.name] = {};
    for (const protocol of args.protocols) {
      runs[size.name][protocol] = [];
      for (let r = 0; r < args.runs; r++) {
        const t0 = Date.now();
        process.stdout.write(
          `[${protocol} ${size.name} ${r + 1}/${args.runs}] running… `,
        );
        try {
          const out = await runBench(protocol, size, r, args.withYoga);
          runs[size.name][protocol]!.push(out);
          const sec = ((Date.now() - t0) / 1000).toFixed(1);
          const bunTarget = TARGET_BY(protocol, 'bun');
          const bunRps = out.results[bunTarget]?.total?.rps ?? 0;
          process.stdout.write(`done in ${sec}s — bun=${bunRps.toFixed(0)} RPS\n`);
        } catch (e) {
          process.stdout.write(
            `FAIL: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}\n`,
          );
        }
      }
    }
  }
  const elapsedMin = ((Date.now() - tStart) / 60000).toFixed(1);
  console.log(`\nMatrix complete in ${elapsedMin} min. Writing ${args.output}`);
  const md = buildMd(runs, args);
  writeFileSync(args.output, md);
  console.log(`Wrote ${args.output} (${md.length} bytes)`);
};

main().catch(err => {
  console.error(err);
  process.exit(1);
});
