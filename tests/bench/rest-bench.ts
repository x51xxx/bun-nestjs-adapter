/**
 * REST benchmark runner — mirror of `graphql-bench.ts` against the REST
 * controller (`rest-nest-{express,fastify,bun}`). Same dataset, same
 * service, same CASL guards, same ValidationPipe — only the protocol is
 * different. Lets the bench isolate Apollo + GraphQL execution overhead.
 *
 * Operation mix matches the GraphQL bench (list 50% / byId 25% / create
 * 15% / merge 10%) so totals are comparable cell-for-cell.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { join } from 'node:path';

type Framework = 'rest-nest-express' | 'rest-nest-fastify' | 'rest-nest-bun';

const ALL_TARGETS: readonly Framework[] = [
  'rest-nest-express',
  'rest-nest-fastify',
  'rest-nest-bun',
];

const FRAMEWORK_DIR = join(import.meta.dir, 'frameworks');

interface Args {
  connections: number;
  duration: number;
  port: number;
  warmupSec: number;
  readyTimeoutMs: number;
  only: Framework[] | null;
  verbose: boolean;
  memSampleMs: number;
  jsonOut: string | null;
}

const DEFAULTS: Args = {
  connections: 50,
  duration: 5,
  port: 3000,
  warmupSec: 1,
  readyTimeoutMs: 30_000,
  only: null,
  verbose: false,
  memSampleMs: 250,
  jsonOut: null,
};

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isFramework(value: string): value is Framework {
  return (ALL_TARGETS as readonly string[]).includes(value);
}

function parseOnly(raw: string | undefined): Framework[] | null {
  if (!raw) return null;
  const list = raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const bad = list.filter(s => !isFramework(s));
  if (bad.length) {
    throw new Error(
      `unknown target(s): ${bad.join(', ')}. valid: ${ALL_TARGETS.join(', ')}`,
    );
  }
  return list as Framework[];
}

function printHelp() {
  console.log(`REST benchmark runner

Usage: bun run tests/bench/rest-bench.ts [options]

Options:
  -c, --connections <n>   Concurrent workers (default ${DEFAULTS.connections})
  -d, --duration <sec>    Measurement window in seconds (default ${DEFAULTS.duration})
      --warmup <sec>      Warmup window in seconds (default ${DEFAULTS.warmupSec})
      --port <n>          Port the framework binds to (default ${DEFAULTS.port})
      --ready-timeout <ms>  Time to wait for readiness (default ${DEFAULTS.readyTimeoutMs})
      --mem-interval <ms>   RSS sampling interval (default ${DEFAULTS.memSampleMs}, 0 disables)
      --json-out <path>     Write machine-readable results to <path> after the run
      --only <list>       Comma-separated subset, e.g. --only rest-nest-bun
      -v, --verbose       Stream child stdout/stderr to this process
  -h, --help              Show this help`);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '-h' || token === '--help') {
      printHelp();
      process.exit(0);
    } else if (token === '-c' || token === '--connections')
      args.connections = parseNumber(argv[++i], args.connections);
    else if (token === '-d' || token === '--duration')
      args.duration = parseNumber(argv[++i], args.duration);
    else if (token === '--port') args.port = parseNumber(argv[++i], args.port);
    else if (token === '--warmup')
      args.warmupSec = parseNumber(argv[++i], args.warmupSec);
    else if (token === '--ready-timeout')
      args.readyTimeoutMs = parseNumber(argv[++i], args.readyTimeoutMs);
    else if (token === '--mem-interval') {
      const raw = argv[++i];
      const n = Number(raw);
      args.memSampleMs = Number.isFinite(n) && n >= 0 ? n : args.memSampleMs;
    } else if (token === '--json-out') args.jsonOut = argv[++i] ?? null;
    else if (token === '--only') args.only = parseOnly(argv[++i]);
    else if (token === '-v' || token === '--verbose') args.verbose = true;
    else throw new Error(`unknown argument: ${token} (try --help)`);
  }
  return args;
}

interface OpStats {
  ok: number;
  errors: number;
  bytes: number;
  latencies: number[];
}

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

type OpKind = 'list' | 'byId' | 'create' | 'merge';
const OP_KINDS: readonly OpKind[] = ['list', 'byId', 'create', 'merge'];

interface MemStats {
  idleBytes: number;
  minBytes: number;
  avgBytes: number;
  maxBytes: number;
  p95Bytes: number;
  samples: number;
}

interface Result {
  byOp: Record<OpKind, OpResult>;
  total: OpResult;
  durationMs: number;
  mem: MemStats;
}

function newOpStats(): OpStats {
  return { ok: 0, errors: 0, bytes: 0, latencies: [] };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarize(stats: OpStats, durationMs: number): OpResult {
  const sorted = stats.latencies.slice().sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    ok: stats.ok,
    errors: stats.errors,
    rps: durationMs > 0 ? (stats.ok / durationMs) * 1000 : 0,
    latencyAvg: stats.ok ? sum / stats.ok : 0,
    latencyP50: percentile(sorted, 50),
    latencyP90: percentile(sorted, 90),
    latencyP99: percentile(sorted, 99),
    throughputBps: durationMs > 0 ? (stats.bytes / durationMs) * 1000 : 0,
  };
}

function mergeOpStats(a: OpStats, b: OpStats): OpStats {
  return {
    ok: a.ok + b.ok,
    errors: a.errors + b.errors,
    bytes: a.bytes + b.bytes,
    latencies: a.latencies.concat(b.latencies),
  };
}

const HEADERS = { 'Content-Type': 'application/json' } as const;

// ---- REST request templates ----
//
// Pre-built so the bench client's per-iteration cost is minimal.

const LIST_PATHS: string[] = (() => {
  const out: string[] = [];
  for (let i = 0; i < 25; i++) out.push(`/todo-items?skip=${i * 20}&take=20`);
  return out;
})();

const BY_ID_PATHS: string[] = (() => {
  const out: string[] = [];
  for (let i = 1; i <= 100; i++) out.push(`/todo-items/${i * 7 + 1}`);
  return out;
})();

const CREATE_PATH = '/todo-items';
const CREATE_BODY = JSON.stringify({
  title: 'Benchmark task',
  completed: false,
  description: 'Created during benchmark run',
  priority: 'HIGH',
  tags: ['urgent', 'work'],
  checklist: [
    { label: 'Plan', done: false },
    { label: 'Execute', done: false },
    { label: 'Ship', done: false },
  ],
  metadata: [
    { key: 'source', value: 'bench' },
    { key: 'estimate', value: '2h' },
  ],
  assigneeId: 5,
});

const MERGE_REQS: Array<{ path: string; body: string }> = (() => {
  const out: Array<{ path: string; body: string }> = [];
  for (let i = 1; i <= 50; i++) {
    out.push({
      path: `/todo-items/${i * 5}/merge`,
      body: JSON.stringify({
        tagsToAdd: ['hot', 'review'],
        tagsToRemove: ['errands'],
        checklistToAdd: [{ label: `Step ${i}`, done: false }],
        metadataPatch: [
          { key: 'rev', value: String(i) },
          { key: 'last_seen', value: 'bench' },
        ],
        commentToAdd: 'Bumped during bench run',
      }),
    });
  }
  return out;
})();

interface RestRequest {
  url: string;
  method: 'GET' | 'POST' | 'PATCH';
  body?: string;
}

interface OpDef {
  kind: OpKind;
  weight: number;
  build(baseUrl: string, counter: number): RestRequest;
}

const OPS: OpDef[] = [
  {
    kind: 'list',
    weight: 50,
    build: (base, c) => ({
      url: base + LIST_PATHS[c % LIST_PATHS.length],
      method: 'GET',
    }),
  },
  {
    kind: 'byId',
    weight: 25,
    build: (base, c) => ({
      url: base + BY_ID_PATHS[c % BY_ID_PATHS.length],
      method: 'GET',
    }),
  },
  {
    kind: 'create',
    weight: 15,
    build: base => ({
      url: base + CREATE_PATH,
      method: 'POST',
      body: CREATE_BODY,
    }),
  },
  {
    kind: 'merge',
    weight: 10,
    build: (base, c) => {
      const r = MERGE_REQS[c % MERGE_REQS.length];
      return { url: base + r.path, method: 'PATCH', body: r.body };
    },
  },
];

const OP_TABLE: OpDef[] = (() => {
  const out: OpDef[] = [];
  for (const op of OPS) for (let i = 0; i < op.weight; i++) out.push(op);
  return out;
})();

type BunWorkerSink = Record<OpKind, OpStats>;

function newSink(): BunWorkerSink {
  return {
    list: newOpStats(),
    byId: newOpStats(),
    create: newOpStats(),
    merge: newOpStats(),
  };
}

async function workerLoop(
  baseUrl: string,
  endsAt: number,
  startCounter: number,
  sink: BunWorkerSink,
) {
  let counter = startCounter;
  while (performance.now() < endsAt) {
    const op = OP_TABLE[counter % OP_TABLE.length];
    const stats = sink[op.kind];
    const req = op.build(baseUrl, counter);
    counter++;
    const t0 = performance.now();
    let ok = false;
    let bytes = 0;
    try {
      const init: RequestInit =
        req.method === 'GET'
          ? { method: 'GET' }
          : { method: req.method, headers: HEADERS, body: req.body };
      const res = await fetch(req.url, init);
      const buf = await res.arrayBuffer();
      bytes = buf.byteLength;
      if (res.status >= 200 && res.status < 300) ok = true;
    } catch {
      ok = false;
    }
    const elapsed = performance.now() - t0;
    stats.bytes += bytes;
    if (ok) {
      stats.ok++;
      stats.latencies.push(elapsed);
    } else {
      stats.errors++;
    }
  }
}

async function bench(
  baseUrl: string,
  args: Args,
  durationSec: number,
  sampler: MemSampler | null = null,
): Promise<Result> {
  const start = performance.now();
  const endsAt = start + durationSec * 1000;
  const sinks: BunWorkerSink[] = Array.from({ length: args.connections }, newSink);
  const workers = sinks.map((sink, i) => workerLoop(baseUrl, endsAt, i * 7, sink));
  await Promise.all(workers);
  const durationMs = performance.now() - start;

  const merged: BunWorkerSink = newSink();
  for (const s of sinks) {
    for (const k of OP_KINDS) merged[k] = mergeOpStats(merged[k], s[k]);
  }
  let total = newOpStats();
  for (const k of OP_KINDS) total = mergeOpStats(total, merged[k]);

  const byOp = {} as Record<OpKind, OpResult>;
  for (const k of OP_KINDS) byOp[k] = summarize(merged[k], durationMs);
  return {
    byOp,
    total: summarize(total, durationMs),
    durationMs,
    mem: sampler
      ? summarizeMem(sampler)
      : {
          idleBytes: 0,
          minBytes: 0,
          avgBytes: 0,
          maxBytes: 0,
          p95Bytes: 0,
          samples: 0,
        },
  };
}

function fmt(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : 'n/a';
}

function fmtBytes(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB/s`;
  if (abs >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)} MB/s`;
  if (abs >= 1024) return `${(n / 1024).toFixed(2)} KB/s`;
  return `${n.toFixed(0)} B/s`;
}

function fmtMB(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'n/a';
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

class MemSampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight = false;
  public readonly samples: number[] = [];
  public idleBytes = 0;

  constructor(
    private readonly pid: number,
    private readonly intervalMs = 250,
  ) {}

  private sampleOnce(): Promise<number> {
    return new Promise(resolve => {
      const proc = spawn('ps', ['-o', 'rss=', '-p', String(this.pid)], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let out = '';
      proc.stdout?.on('data', (c: Buffer) => {
        out += c.toString('utf8');
      });
      proc.once('exit', () => {
        const kb = Number(out.trim());
        resolve(Number.isFinite(kb) && kb > 0 ? kb * 1024 : 0);
      });
      proc.once('error', () => resolve(0));
    });
  }

  async captureIdle() {
    this.idleBytes = await this.sampleOnce();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      if (this.inflight) return;
      this.inflight = true;
      try {
        const v = await this.sampleOnce();
        if (v > 0) this.samples.push(v);
      } finally {
        this.inflight = false;
      }
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function summarizeMem(s: MemSampler): MemStats {
  if (s.samples.length === 0) {
    return {
      idleBytes: s.idleBytes,
      minBytes: s.idleBytes,
      avgBytes: s.idleBytes,
      maxBytes: s.idleBytes,
      p95Bytes: s.idleBytes,
      samples: 0,
    };
  }
  const sorted = s.samples.slice().sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    idleBytes: s.idleBytes,
    minBytes: sorted[0],
    avgBytes: sum / sorted.length,
    maxBytes: sorted[sorted.length - 1],
    p95Bytes: sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))],
    samples: sorted.length,
  };
}

function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const sock = createConnection({ port, host });
    const done = (open: boolean) => {
      sock.destroy();
      resolve(open);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(250, () => done(false));
  });
}

interface SpawnedTarget {
  child: ChildProcess;
  stderr: string;
}

function spawnTarget(
  framework: Framework,
  port: number,
  verbose: boolean,
): SpawnedTarget {
  // `process.execPath`, not a bare 'bun': the target servers must run on the
  // same runtime as this harness. Resolving 'bun' from PATH silently benchmarked
  // whatever bun happened to be installed, which makes any runtime A/B
  // (e.g. 1.3.x vs 1.4 canary) measure nothing.
  const child = spawn(process.execPath, ['run', join(FRAMEWORK_DIR, `${framework}.ts`)], {
    stdio: verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port) },
  });
  const result: SpawnedTarget = { child, stderr: '' };
  if (!verbose) {
    const MAX = 16 * 1024;
    child.stderr?.on('data', (chunk: Buffer) => {
      if (result.stderr.length < MAX) {
        result.stderr += chunk.toString('utf8');
        if (result.stderr.length > MAX) {
          result.stderr = `${result.stderr.slice(0, MAX)}\n…[truncated]`;
        }
      }
    });
    child.stdout?.resume();
  }
  return result;
}

async function waitReady(
  baseUrl: string,
  target: SpawnedTarget,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  const probeUrl = `${baseUrl}/todo-items?skip=0&take=1`;
  while (Date.now() - start < timeoutMs) {
    if (target.child.exitCode != null) {
      throw new Error(
        `child exited early with code ${target.child.exitCode}\n--- stderr ---\n${target.stderr || '(empty)'}`,
      );
    }
    try {
      const res = await fetch(probeUrl);
      if (res.status === 200) {
        await res.body?.cancel();
        return;
      }
      lastErr = new Error(`status ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(
    `server did not become ready: ${probeUrl} (last: ${lastErr instanceof Error ? lastErr.message : String(lastErr)})\n--- stderr ---\n${target.stderr || '(empty)'}`,
  );
}

function killChild(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    if (!child || child.exitCode != null || child.killed) return resolve();
    const onExit = () => resolve();
    child.once('exit', onExit);
    try {
      child.kill('SIGTERM');
    } catch {}
    setTimeout(() => {
      try {
        if (child.exitCode == null) child.kill('SIGKILL');
      } catch {}
    }, 800).unref?.();
    setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve();
    }, 2_000).unref?.();
  });
}

function printRun(framework: Framework, args: Args, baseUrl: string, result: Result) {
  const row = (label: string, r: OpResult) => {
    console.log(
      `  ${label.padEnd(8)}  ok=${String(r.ok).padStart(7)}  errors=${String(r.errors).padStart(4)}  RPS=${fmt(r.rps, 0).padStart(6)}  avg=${fmt(r.latencyAvg).padStart(6)}ms  p50=${fmt(r.latencyP50).padStart(6)}ms  p90=${fmt(r.latencyP90).padStart(6)}ms  p99=${fmt(r.latencyP99).padStart(6)}ms`,
    );
  };
  console.log(`\n=== ${framework.toUpperCase()} ===`);
  console.log(`Target: ${baseUrl}`);
  console.log(
    `connections=${args.connections} duration=${args.duration}s warmup=${args.warmupSec}s ` +
      `mix=${OPS.map(o => `${o.kind}:${o.weight}%`).join(' ')}`,
  );
  row('total', result.total);
  for (const k of OP_KINDS) row(k, result.byOp[k]);
  console.log(`  throughput=${fmtBytes(result.total.throughputBps)}`);
  const m = result.mem;
  if (m.samples > 0) {
    const delta = m.avgBytes - m.idleBytes;
    const sign = delta >= 0 ? '+' : '';
    console.log(
      `  rss        idle=${fmtMB(m.idleBytes).padStart(7)}  min=${fmtMB(m.minBytes).padStart(7)}  avg=${fmtMB(m.avgBytes).padStart(7)}  p95=${fmtMB(m.p95Bytes).padStart(7)}  max=${fmtMB(m.maxBytes).padStart(7)}  Δavg=${sign}${fmtMB(Math.abs(delta))}  (${m.samples} samples)`,
    );
  } else if (m.idleBytes > 0) {
    console.log(`  rss        idle=${fmtMB(m.idleBytes)} (no samples — bench too short)`);
  }
}

let active: ChildProcess | null = null;

async function runOne(framework: Framework, args: Args): Promise<Result> {
  const portBusy = await isPortOpen(args.port);
  if (portBusy) {
    throw new Error(
      `port ${args.port} is already in use — kill the previous process first`,
    );
  }
  const target = spawnTarget(framework, args.port, args.verbose);
  active = target.child;
  const baseUrl = `http://127.0.0.1:${args.port}`;
  try {
    await waitReady(baseUrl, target, args.readyTimeoutMs);
    const sampler = target.child.pid
      ? new MemSampler(target.child.pid, args.memSampleMs)
      : null;
    if (sampler) await sampler.captureIdle();
    if (args.warmupSec > 0) await bench(baseUrl, args, args.warmupSec);
    sampler?.start();
    let result: Result;
    try {
      result = await bench(baseUrl, args, args.duration, sampler);
    } finally {
      sampler?.stop();
    }
    printRun(framework, args, baseUrl, result);
    return result;
  } finally {
    await killChild(target.child);
    active = null;
    await new Promise(r => setTimeout(r, 250));
  }
}

function pctChange(a: number, b: number): string {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return 'n/a';
  const p = ((a - b) / b) * 100;
  return `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`;
}

function compare(
  name: string,
  baseline: Result | undefined,
  candidate: Result | undefined,
) {
  console.log(`\n--- ${name} ---`);
  if (!baseline || !candidate) {
    console.log('  (skipped — missing one side)');
    return;
  }
  const row = (label: string, a: OpResult, b: OpResult) => {
    console.log(
      `  ${label.padEnd(8)}  RPS ${fmt(a.rps, 0)} -> ${fmt(b.rps, 0)} (${pctChange(b.rps, a.rps)})  p99 ${fmt(a.latencyP99)} -> ${fmt(b.latencyP99)} (${pctChange(b.latencyP99, a.latencyP99)})`,
    );
  };
  row('total', baseline.total, candidate.total);
  for (const k of OP_KINDS) row(k, baseline.byOp[k], candidate.byOp[k]);
  if (baseline.mem.samples > 0 && candidate.mem.samples > 0) {
    const memRow = (label: string, a: number, b: number) => {
      console.log(
        `  ${label.padEnd(8)}  ${fmtMB(a)} -> ${fmtMB(b)} (${pctChange(b, a)})`,
      );
    };
    memRow('rss avg', baseline.mem.avgBytes, candidate.mem.avgBytes);
    memRow('rss p95', baseline.mem.p95Bytes, candidate.mem.p95Bytes);
    memRow('rss max', baseline.mem.maxBytes, candidate.mem.maxBytes);
  }
}

function installSignalHandlers() {
  const cleanup = (signal: NodeJS.Signals) => {
    if (active) {
      try {
        active.kill('SIGTERM');
      } catch {}
    }
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));
}

class CliError extends Error {}

async function main() {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e));
  }
  installSignalHandlers();

  console.log(
    `REST benchmark runner (client: Bun ${(globalThis as any).Bun?.version ?? '?'})`,
  );

  const targets = args.only ?? [...ALL_TARGETS];
  const results: Partial<Record<Framework, Result>> = {};
  for (const fw of targets) {
    try {
      results[fw] = await runOne(fw, args);
    } catch (e) {
      console.error(`\n[FAIL] ${fw}:`, e instanceof Error ? e.message : e);
    }
  }

  if (targets.includes('rest-nest-express') && targets.includes('rest-nest-bun')) {
    compare(
      'REST NEST-EXPRESS vs NEST-BUN',
      results['rest-nest-express'],
      results['rest-nest-bun'],
    );
  }
  if (targets.includes('rest-nest-fastify') && targets.includes('rest-nest-bun')) {
    compare(
      'REST NEST-FASTIFY vs NEST-BUN',
      results['rest-nest-fastify'],
      results['rest-nest-bun'],
    );
  }

  if (args.jsonOut) {
    const payload = {
      args: {
        connections: args.connections,
        duration: args.duration,
        warmupSec: args.warmupSec,
        memSampleMs: args.memSampleMs,
      },
      bunVersion: (globalThis as any).Bun?.version ?? null,
      timestamp: new Date().toISOString(),
      mix: OPS.map(o => ({ kind: o.kind, weight: o.weight })),
      results,
    };
    await Bun.write(args.jsonOut, JSON.stringify(payload, null, 2));
  }
}

main().catch(err => {
  if (err instanceof CliError) {
    console.error(`error: ${err.message}`);
    console.error('try --help');
    process.exit(2);
  }
  console.error(err);
  process.exit(1);
});
