import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BunHttpAdapter } from '../../src';

// Regression tests for the 2026-09-06 audit (see AUDIT.md):
//
//   M8 — only the first static mount covering a path was ever consulted, so a
//        second root on the same prefix was dead weight. `serve-static` chains
//        mounts through `next()`; measured against @nestjs/platform-express,
//        the second root does answer what the first lacks.
//   M9 — a malformed JSON body was swallowed and the handler got `undefined`.
//        `body-parser` answers 400; measured against platform-express, Nest
//        renders `{"message":…,"error":"Bad Request","statusCode":400}`.
//
// Everything runs through both dispatchers: the `middleware` variant registers
// a pass-through `use()` handler, which is all it takes to leave the native
// route map behind.

let app: { close(): Promise<unknown>; getHttpServer(): any } | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

async function boot(
  moduleClass: unknown,
  configure?: (app: any) => void,
): Promise<string> {
  const created = await NestFactory.create(moduleClass as never, new BunHttpAdapter(), {
    logger: false,
  });
  configure?.(created);
  await created.listen(0, '127.0.0.1');
  app = created as never;
  return `http://127.0.0.1:${created.getHttpServer().address().port}`;
}

const DISPATCHERS = [
  ['native routes', false],
  ['fetch dispatcher', true],
] as const;

/** A no-op `use()` handler is enough to force the manual dispatcher. */
const passthrough = (a: any) =>
  a.use((_r: unknown, _s: unknown, next: () => void) => next());

// ── M8 ──────────────────────────────────────────────────────────────────────

let sandbox = '';
let rootA = '';
let rootB = '';

@Controller()
class UnderPrefixController {
  // Lives *under* the static prefix: proves the request still reaches routing
  // once every mount has missed.
  @Get('s/from-a-route')
  route() {
    return { from: 'route' };
  }
}

@Module({ controllers: [UnderPrefixController] })
class StaticModule {}

describe('M8 — static mounts on one prefix are all consulted', () => {
  beforeAll(async () => {
    sandbox = await fs.mkdtemp(join(tmpdir(), 'bun-adapter-mounts-'));
    rootA = join(sandbox, 'a');
    rootB = join(sandbox, 'b');
    await fs.mkdir(rootA);
    await fs.mkdir(rootB);
    await fs.writeFile(join(rootA, 'only-a.txt'), 'FROM_A');
    await fs.writeFile(join(rootB, 'only-b.txt'), 'FROM_B');
    await fs.writeFile(join(rootA, 'both.txt'), 'A_WINS');
    await fs.writeFile(join(rootB, 'both.txt'), 'B_LOSES');
  });

  afterAll(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  const mountBoth = (a: any) => {
    a.useStaticAssets(rootA, { prefix: '/s' });
    a.useStaticAssets(rootB, { prefix: '/s' });
  };

  for (const [label, withMiddleware] of DISPATCHERS) {
    const configure = (a: any) => {
      if (withMiddleware) passthrough(a);
      mountBoth(a);
    };

    it(`serves from the first mount — ${label}`, async () => {
      const base = await boot(StaticModule, configure);
      const res = await fetch(`${base}/s/only-a.txt`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('FROM_A');
    });

    it(`falls through to the second mount on a miss — ${label}`, async () => {
      const base = await boot(StaticModule, configure);
      const res = await fetch(`${base}/s/only-b.txt`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('FROM_B');
    });

    it(`registration order decides when both have the file — ${label}`, async () => {
      const base = await boot(StaticModule, configure);
      const res = await fetch(`${base}/s/both.txt`);
      expect(await res.text()).toBe('A_WINS');
    });

    it(`404s when every mount misses — ${label}`, async () => {
      const base = await boot(StaticModule, configure);
      const res = await fetch(`${base}/s/nowhere.txt`);
      expect(res.status).toBe(404);
    });

    it(`still reaches a route under the prefix — ${label}`, async () => {
      const base = await boot(StaticModule, configure);
      const res = await fetch(`${base}/s/from-a-route`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ from: 'route' });
    });
  }

  it('keeps mounts on different prefixes independent', async () => {
    const base = await boot(StaticModule, a => {
      a.useStaticAssets(rootA, { prefix: '/a' });
      a.useStaticAssets(rootB, { prefix: '/b' });
    });
    const fromA = await fetch(`${base}/a/only-a.txt`);
    const crossed = await fetch(`${base}/a/only-b.txt`);
    expect(await fromA.text()).toBe('FROM_A');
    expect(crossed.status).toBe(404);
  });
});

// ── M9 ──────────────────────────────────────────────────────────────────────

@Controller()
class BodyController {
  @Post('json')
  json(@Body() body: unknown) {
    return { body, t: typeof body };
  }

  // No `@Body()` at all: the parser rejects the payload before dispatch, so
  // this must not run either.
  @Post('ignores-body')
  ignoresBody() {
    return { ran: true };
  }

  @Post('text')
  text(@Body() body: unknown) {
    return { body };
  }
}

@Module({ controllers: [BodyController] })
class BodyModule {}

const postJson = (body: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body,
});

describe('M9 — a malformed JSON body is rejected with 400', () => {
  for (const [label, withMiddleware] of DISPATCHERS) {
    const configure = withMiddleware ? passthrough : undefined;

    it(`answers 400 in Nest's Bad Request shape — ${label}`, async () => {
      const base = await boot(BodyModule, configure);
      const res = await fetch(`${base}/json`, postJson('{oops'));
      expect(res.status).toBe(400);
      // Same shape platform-express produces; only the parser's wording
      // differs between runtimes, so assert the contract, not the prose.
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.statusCode).toBe(400);
      expect(json.error).toBe('Bad Request');
      expect(typeof json.message).toBe('string');
    });

    it(`does not run the handler — ${label}`, async () => {
      const base = await boot(BodyModule, configure);
      const res = await fetch(`${base}/ignores-body`, postJson('{oops'));
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain('"ran"');
    });

    it(`leaves a valid JSON body alone — ${label}`, async () => {
      const base = await boot(BodyModule, configure);
      const res = await fetch(`${base}/json`, postJson('{"a":1}'));
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ body: { a: 1 }, t: 'object' });
    });

    it(`does not police a non-JSON content type — ${label}`, async () => {
      const base = await boot(BodyModule, configure);
      const res = await fetch(`${base}/text`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: '{oops',
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ body: '{oops' });
    });
  }

  it('still rejects with rawBody enabled', async () => {
    const created = await NestFactory.create(BodyModule, new BunHttpAdapter(), {
      logger: false,
      rawBody: true,
    });
    await created.listen(0, '127.0.0.1');
    app = created as never;
    const base = `http://127.0.0.1:${created.getHttpServer().address().port}`;
    const res = await fetch(`${base}/json`, postJson('{oops'));
    expect(res.status).toBe(400);
  });
});
