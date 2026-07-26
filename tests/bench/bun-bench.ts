import { type ChildProcess, spawn } from 'node:child_process';
/**
 * Bun-native benchmark runner.
 *
 * Spawns each framework target as a child process (Bun for bun targets, Node
 * via tsx for Node targets) and hits it with parallel `fetch()` from the
 * SAME Bun runtime, so all targets share one HTTP client and the latency
 * profile reflects Bun's native fetch behavior — not autocannon-on-Node.
 */
import { join } from 'node:path';

type Framework =
  | 'express'
  | 'fastify'
  | 'nest-express'
  | 'nest-fastify'
  | 'bun'
  | 'nest-bun';

// All targets are .ts and we run them through Bun. Even Node-style frameworks
// work since Bun ships a Node-compatible runtime.
const FRAMEWORK_DIR = join(import.meta.dir, 'frameworks');

interface Args {
  connections: number;
  duration: number;
  port: number;
  path: string;
  warmupSec: number;
}

const DEFAULTS: Args = {
  connections: 50,
  duration: 5,
  port: 3000,
  path: '/',
  warmupSec: 1,
};

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '-c' || token === '--connections')
      args.connections = parseNumber(argv[++i], args.connections);
    else if (token === '-d' || token === '--duration')
      args.duration = parseNumber(argv[++i], args.duration);
    else if (token === '--port') args.port = parseNumber(argv[++i], args.port);
    else if (token === '--path') args.path = argv[++i] ?? args.path;
    else if (token === '--warmup')
      args.warmupSec = parseNumber(argv[++i], args.warmupSec);
  }
  return args;
}

interface Result {
  requests: number;
  rps: number;
  errors: number;
  bytes: number;
  latencyAvg: number;
  latencyP50: number;
  latencyP90: number;
  latencyP99: number;
  throughputBps: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function workerLoop(
  url: string,
  endsAt: number,
  out: { requests: number; errors: number; bytes: number; latencies: number[] },
) {
  while (performance.now() < endsAt) {
    const t0 = performance.now();
    try {
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      out.bytes += buf.byteLength;
      out.requests++;
      out.latencies.push(performance.now() - t0);
    } catch {
      out.errors++;
    }
  }
}

async function bench(url: string, args: Args): Promise<Result> {
  const start = performance.now();
  const endsAt = start + args.duration * 1000;
  const out = { requests: 0, errors: 0, bytes: 0, latencies: [] as number[] };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < args.connections; i++) {
    workers.push(workerLoop(url, endsAt, out));
  }
  await Promise.all(workers);
  const durationMs = performance.now() - start;
  const sorted = out.latencies.slice().sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    requests: out.requests,
    rps: (out.requests / durationMs) * 1000,
    errors: out.errors,
    bytes: out.bytes,
    latencyAvg: out.requests ? sum / out.requests : 0,
    latencyP50: percentile(sorted, 50),
    latencyP90: percentile(sorted, 90),
    latencyP99: percentile(sorted, 99),
    throughputBps: (out.bytes / durationMs) * 1000,
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

function spawnTarget(framework: Framework): ChildProcess {
  // `process.execPath`, not a bare 'bun': the target servers must run on the
  // same runtime as this harness. Resolving 'bun' from PATH silently benchmarked
  // whatever bun happened to be installed, which makes any runtime A/B
  // (e.g. 1.3.x vs 1.4 canary) measure nothing.
  return spawn(process.execPath, ['run', join(FRAMEWORK_DIR, `${framework}.ts`)], {
    stdio: 'ignore',
  });
}

async function waitReady(url: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status === 200 || res.status === 404) return;
    } catch {
      /* not ready */
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`server did not become ready: ${url}`);
}

function killChild(child: ChildProcess) {
  if (!child || child.killed) return;
  try {
    child.kill('SIGTERM');
  } catch {}
  setTimeout(() => {
    try {
      if (!child.killed) child.kill('SIGKILL');
    } catch {}
  }, 800).unref?.();
}

async function runOne(framework: Framework, args: Args): Promise<Result> {
  const child = spawnTarget(framework);
  const url = `http://127.0.0.1:${args.port}${args.path.startsWith('/') ? args.path : `/${args.path}`}`;
  try {
    await waitReady(url);
    console.log(`\n=== ${framework.toUpperCase()} ===`);
    console.log(`Target: ${url}`);
    console.log(
      `connections=${args.connections} duration=${args.duration}s warmup=${args.warmupSec}s`,
    );
    await bench(url, { ...args, duration: args.warmupSec });
    const result = await bench(url, args);
    console.log(
      `Requests: ${result.requests}  RPS: ${fmt(result.rps, 0)}  errors: ${result.errors}`,
    );
    console.log(
      `Latency (ms): avg=${fmt(result.latencyAvg)}  p50=${fmt(result.latencyP50)}  p90=${fmt(result.latencyP90)}  p99=${fmt(result.latencyP99)}`,
    );
    console.log(`Throughput: ${fmtBytes(result.throughputBps)}`);
    return result;
  } finally {
    killChild(child);
    await new Promise(r => setTimeout(r, 250));
  }
}

function pctChange(a: number, b: number): string {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return 'n/a';
  const p = ((a - b) / b) * 100;
  return `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`;
}

function compare(name: string, a: Result | undefined, b: Result | undefined) {
  console.log(`\n--- ${name} ---`);
  if (!a || !b) return;
  console.log(`RPS: ${fmt(a.rps, 0)} -> ${fmt(b.rps, 0)} (${pctChange(b.rps, a.rps)})`);
  console.log(
    `Latency avg (ms): ${fmt(a.latencyAvg)} -> ${fmt(b.latencyAvg)} (${pctChange(b.latencyAvg, a.latencyAvg)})`,
  );
  console.log(
    `Latency p99 (ms): ${fmt(a.latencyP99)} -> ${fmt(b.latencyP99)} (${pctChange(b.latencyP99, a.latencyP99)})`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `Bun-native benchmark runner (client: Bun ${(globalThis as any).Bun?.version ?? '?'})`,
  );

  const targets: Framework[] = [
    'express',
    'nest-express',
    'fastify',
    'nest-fastify',
    'bun',
    'nest-bun',
  ];
  const results: Partial<Record<Framework, Result>> = {};
  for (const fw of targets) {
    try {
      results[fw] = await runOne(fw, args);
    } catch (e) {
      console.error(`failed: ${fw}:`, e);
    }
  }

  compare('EXPRESS vs NEST-EXPRESS', results.express, results['nest-express']);
  compare('FASTIFY vs NEST-FASTIFY', results.fastify, results['nest-fastify']);
  compare('BUN vs NEST-BUN', results.bun, results['nest-bun']);
  compare('NEST-EXPRESS vs NEST-BUN', results['nest-express'], results['nest-bun']);
  compare('NEST-FASTIFY vs NEST-BUN', results['nest-fastify'], results['nest-bun']);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
