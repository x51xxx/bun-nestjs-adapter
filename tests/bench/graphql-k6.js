/**
 * k6 load script for the GraphQL benchmark. Driven by `graphql-bench-k6.ts`,
 * which spawns one `k6 run` per target and reads the per-op JSON this script
 * writes via `handleSummary`.
 *
 * Mirrors `rest-k6.js` (external Go load generator, no co-located bun-`fetch`
 * client) so REST and GraphQL are measured with the same instrument. The
 * queries/selections match `graphql-bench.ts` exactly, so the REST projections
 * stay byte-comparable.
 *
 * Operation mix: list 50% / byId 25% / create 15% / merge 10%.
 *
 * Env: BASE (required), VUS (default 50), DUR (default "10s"), OUT (per-op
 * summary path; omitted on warmup runs).
 */
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

const BASE = __ENV.BASE;
const OUT = __ENV.OUT || '';
const VUS = Number(__ENV.VUS || '50');
const DUR = __ENV.DUR || '10s';

// ---- Query templates (mirror graphql-bench.ts) ----
const LIST_QUERY =
  'query L($skip:Int!,$take:Int!){todoItems(skip:$skip,take:$take){id title completed priority tags assignee{id name email} comments{id body createdAt} checklist{label done} metadata{key value} createdAt updatedAt}}';
const BY_ID_QUERY =
  'query B($id:Int!){todoItem(id:$id){id title completed description priority tags dueAt assignee{id name email} comments{id body authorId createdAt} checklist{label done} metadata{key value} createdAt updatedAt}}';
const CREATE_MUTATION =
  'mutation C($input:CreateTodoItemInput!){createOneTodoItem(input:$input){id title completed priority tags checklist{label done} metadata{key value} createdAt updatedAt assignee{id name email}}}';
const MERGE_MUTATION =
  'mutation M($id:Int!,$input:MergeTodoItemInput!){mergeTodoItem(id:$id,input:$input){id title tags checklist{label done} metadata{key value} comments{id body createdAt} updatedAt}}';

const CREATE_INPUT = {
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
};

const MERGE_INPUT = i => ({
  tagsToAdd: ['hot', 'review'],
  tagsToRemove: ['errands'],
  checklistToAdd: [{ label: `Step ${i}`, done: false }],
  metadataPatch: [
    { key: 'rev', value: String(i) },
    { key: 'last_seen', value: 'bench' },
  ],
  commentToAdd: 'Bumped during bench run',
});

const OP_TABLE = (() => {
  const t = [];
  const push = (k, n) => {
    for (let i = 0; i < n; i++) t.push(k);
  };
  push('list', 50);
  push('byId', 25);
  push('create', 15);
  push('merge', 10);
  return t;
})();

const OPS = ['list', 'byId', 'create', 'merge'];
const lat = {};
const okC = {};
const errC = {};
const byteC = {};
for (const k of OPS) {
  lat[k] = new Trend(`op_${k}_lat`, true);
  okC[k] = new Counter(`op_${k}_ok`);
  errC[k] = new Counter(`op_${k}_err`);
  byteC[k] = new Counter(`op_${k}_bytes`);
}

const PARAMS = { headers: { 'Content-Type': 'application/json' } };

export const options = {
  scenarios: {
    mix: { executor: 'constant-vus', vus: VUS, duration: DUR, gracefulStop: '2s' },
  },
  discardResponseBodies: false,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(99)', 'max'],
};

export default function () {
  const counter = exec.scenario.iterationInTest;
  const op = OP_TABLE[counter % OP_TABLE.length];
  let body;
  switch (op) {
    case 'list':
      body = { query: LIST_QUERY, variables: { skip: (counter % 25) * 20, take: 20 } };
      break;
    case 'byId':
      body = { query: BY_ID_QUERY, variables: { id: ((counter % 100) + 1) * 7 } };
      break;
    case 'create':
      body = { query: CREATE_MUTATION, variables: { input: CREATE_INPUT } };
      break;
    default:
      body = {
        query: MERGE_MUTATION,
        variables: {
          id: ((counter % 50) + 1) * 5,
          input: MERGE_INPUT((counter % 50) + 1),
        },
      };
  }
  const res = http.post(BASE + '/graphql', JSON.stringify(body), {
    ...PARAMS,
    tags: { op },
  });
  // GraphQL replies 200 even on errors; treat an `errors` array as a failure.
  const ok = res.status === 200 && res.body && !res.body.includes('"errors"');
  if (ok) {
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
  return files;
}
