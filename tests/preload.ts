import 'reflect-metadata';
import { afterAll, beforeAll } from 'bun:test';

// Mocha → Bun shim, so unmodified upstream nestjs/nest fixture specs that
// use `before` / `after` keep working under `bun test`.
const g = globalThis as any;
if (typeof g.before !== 'function') g.before = beforeAll;
if (typeof g.after !== 'function') g.after = afterAll;
