// Preload for `bun run test:upstream-e2e`: runs nestjs/nest's own e2e specs
// (supertest, `describe.each` over Express and Fastify) against the Bun
// adapter, unmodified. Both adapter imports resolve to BunHttpAdapter, so each
// spec runs twice on Bun — once per upstream variant. A separate process from
// `bun run test` on purpose: `mock.module` is process-wide, and the audit specs
// import the real ExpressAdapter to compare against.
import { mock } from 'bun:test';
import { BunHttpAdapter } from '../../src';

class ExpressAdapter extends BunHttpAdapter {}
// Constructs a Bun adapter while `instanceof FastifyAdapter` stays false, so a
// spec skips its Fastify-only setup (`getInstance().addHook(...)`).
function FastifyAdapter() {
  return new ExpressAdapter();
}

mock.module('@nestjs/platform-express', () => ({ ExpressAdapter }));
mock.module('@nestjs/platform-fastify', () => ({ FastifyAdapter }));

// Known divergences are filtered out by the `-t` pattern in the
// `test:upstream-e2e` script (Bun binds `it` per file, so it can't be wrapped
// here). Currently one:
//
//   "should fail loudly when reading signed cookies" — the request shim always
//   carries `req.signedCookies`, i.e. it behaves like express *with*
//   cookie-parser installed, where Nest reads that object instead of
//   throwing. Dropping it would break code that reads `req.signedCookies.x`.
