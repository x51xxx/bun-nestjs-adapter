/**
 * k6 load script for the REST benchmark. Driven by `rest-bench-k6.ts`, which
 * spawns one `k6 run` per target and reads the per-op JSON this script writes
 * via `handleSummary`.
 *
 * Why k6 instead of the in-process Bun `fetch` client used by `rest-bench.ts`:
 * a single-threaded Bun-fetch generator co-located with a Bun server contends
 * for the same JSC runtime + cores and under-reports the bun target. k6 is a
 * separate multi-threaded Go process, so it measures the server, not the
 * client. See BENCHMARK.md methodology.
 *
 * Operation mix matches rest-bench.ts / graphql-bench.ts exactly:
 *   list 50% / byId 25% / create 15% / merge 10%.
 *
 * Env (set by the orchestrator):
 *   BASE  — http://host:port of the target (required)
 *   VUS   — virtual users == "connections" (default 50)
 *   DUR   — k6 duration string, e.g. "10s" (default "10s")
 *   OUT   — absolute path to write the per-op summary JSON (optional; warmup
 *           runs omit it)
 */
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

const BASE = __ENV.BASE;
const OUT = __ENV.OUT || '';
const VUS = Number(__ENV.VUS || '50');
const DUR = __ENV.DUR || '10s';

// ---- Request templates (mirror rest-bench.ts so payloads are identical) ----
const LIST_PATHS = (() => {
  const out = [];
  for (let i = 0; i < 25; i++) out.push(`/todo-items?skip=${i * 20}&take=20`);
  return out;
})();

const BY_ID_PATHS = (() => {
  const out = [];
  for (let i = 1; i <= 100; i++) out.push(`/todo-items/${i * 7 + 1}`);
  return out;
})();

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

const MERGE_REQS = (() => {
  const out = [];
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

const JSON_PARAMS = { headers: { 'Content-Type': 'application/json' } };

// Weighted 100-entry op table → exact 50/25/15/10 split, walked by the global
// scenario iteration counter so the distribution holds regardless of VU count.
const OP_TABLE = (() => {
  const t = [];
  const push = (kind, n) => {
    for (let i = 0; i < n; i++) t.push(kind);
  };
  push('list', 50);
  push('byId', 25);
  push('create', 15);
  push('merge', 10);
  return t;
})();

// ---- Per-op metrics ----
const OPS = ['list', 'byId', 'create', 'merge'];
const lat = {};
const okC = {};
const errC = {};
const byteC = {};
for (const k of OPS) {
  lat[k] = new Trend(`op_${k}_lat`, true); // isTime → values in ms
  okC[k] = new Counter(`op_${k}_ok`);
  errC[k] = new Counter(`op_${k}_err`);
  byteC[k] = new Counter(`op_${k}_bytes`);
}

export const options = {
  scenarios: {
    mix: { executor: 'constant-vus', vus: VUS, duration: DUR, gracefulStop: '2s' },
  },
  discardResponseBodies: false, // need body length for per-op throughput
  // Percentiles the orchestrator maps to p50/p90/p99.
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(99)', 'max'],
};

export default function () {
  const counter = exec.scenario.iterationInTest;
  const op = OP_TABLE[counter % OP_TABLE.length];
  let res;
  switch (op) {
    case 'list':
      res = http.get(BASE + LIST_PATHS[counter % LIST_PATHS.length], {
        tags: { op },
      });
      break;
    case 'byId':
      res = http.get(BASE + BY_ID_PATHS[counter % BY_ID_PATHS.length], {
        tags: { op },
      });
      break;
    case 'create':
      res = http.post(BASE + '/todo-items', CREATE_BODY, {
        ...JSON_PARAMS,
        tags: { op },
      });
      break;
    default: {
      const m = MERGE_REQS[counter % MERGE_REQS.length];
      res = http.patch(BASE + m.path, m.body, { ...JSON_PARAMS, tags: { op } });
    }
  }

  if (res.status >= 200 && res.status < 300) {
    okC[op].add(1);
    lat[op].add(res.timings.duration);
    byteC[op].add(res.body ? res.body.length : 0);
  } else {
    errC[op].add(1);
  }
}

export function handleSummary(data) {
  const m = data.metrics;
  const val = (name, key) => {
    const metric = m[name];
    if (!metric || !metric.values || metric.values[key] == null) return 0;
    return metric.values[key];
  };
  const opSummary = k => ({
    ok: val(`op_${k}_ok`, 'count'),
    errors: val(`op_${k}_err`, 'count'),
    bytes: val(`op_${k}_bytes`, 'count'),
    latAvg: val(`op_${k}_lat`, 'avg'),
    latP50: val(`op_${k}_lat`, 'med'),
    latP90: val(`op_${k}_lat`, 'p(90)'),
    latP99: val(`op_${k}_lat`, 'p(99)'),
  });

  const summary = {};
  let okTotal = 0;
  let errTotal = 0;
  let byteTotal = 0;
  for (const k of OPS) {
    summary[k] = opSummary(k);
    okTotal += summary[k].ok;
    errTotal += summary[k].errors;
    byteTotal += summary[k].bytes;
  }
  // Total latency from the global http_req_duration trend (covers every op).
  summary.total = {
    ok: okTotal,
    errors: errTotal,
    bytes: byteTotal,
    latAvg: val('http_req_duration', 'avg'),
    latP50: val('http_req_duration', 'med'),
    latP90: val('http_req_duration', 'p(90)'),
    latP99: val('http_req_duration', 'p(99)'),
  };

  const files = {};
  if (OUT) files[OUT] = JSON.stringify(summary);
  // Returning an object replaces k6's default stdout summary (kept quiet).
  return files;
}
