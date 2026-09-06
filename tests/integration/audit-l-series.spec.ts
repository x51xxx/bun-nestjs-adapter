import { afterEach, describe, expect, it } from 'bun:test';
import { connect } from 'net';
import { Body, Controller, Get, Module, Param, Post, Req, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { BunHttpAdapter, BunWsAdapter } from '../../src';
import type { BunRequest, BunResponse } from '../../src';

// Regression tests for the L-series of the 2026-09-06 audit (see AUDIT.md).
// Each behaviour that has an Express counterpart was read off a real
// @nestjs/platform-express app before it was written here:
//
//   L2  `/x/:a-:b` → { a, b }, greedily: `/x/foo-bar-baz` → a='foo-bar'
//   L4  a WebSocket that closes abnormally raises 'error' (Bun has no error cb)
//   L8  `maxAge` emits `Expires` too, and overrides an explicit `expires`
//   L9  `enableCors()` after `listen()` takes effect
//   L10 `a=1&a=2` in a urlencoded body → ['1','2'], as in the query string
//   L11 `Host: [::1]:1234` → hostname '[::1]'
//   L13 `close()` waits for Bun's stop() instead of dropping the promise
//   L14 both dispatchers route a handler error through setErrorHandler()
//   L7  per-method route buckets, merged so registration order is preserved

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

/** Raw request — `fetch` normalises headers this needs to send verbatim. */
function rawRequest(base: string, lines: string[]): Promise<string> {
  const port = Number(new URL(base).port);
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1', () =>
      socket.write(`${lines.join('\r\n')}\r\n\r\n`),
    );
    let buf = '';
    socket.on('data', d => {
      buf += d.toString();
    });
    socket.on('close', () => resolve(buf));
    socket.on('error', () => resolve(buf));
  });
}

const DISPATCHERS = [
  ['native routes', false],
  ['fetch dispatcher', true],
] as const;

const passthrough = (a: any) =>
  a.use((_r: unknown, _s: unknown, next: () => void) => next());

// ── L2 ──────────────────────────────────────────────────────────────────────

@Controller()
class ParamController {
  @Get('x/:a-:b')
  pair(@Param() p: Record<string, string>) {
    return p;
  }

  @Get('v:major.:minor')
  version(@Param() p: Record<string, string>) {
    return p;
  }

  @Get('one/:id')
  one(@Param('id') id: string) {
    return { id };
  }
}

@Module({ controllers: [ParamController] })
class ParamModule {}

describe('L2 — several params in one segment', () => {
  it('splits :a-:b', async () => {
    const base = await boot(ParamModule);
    const res = await fetch(`${base}/x/foo-bar`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ a: 'foo', b: 'bar' });
  });

  it('is greedy, like path-to-regexp', async () => {
    const base = await boot(ParamModule);
    const res = await fetch(`${base}/x/foo-bar-baz`);
    // Verified against platform-express: the first group takes as much as it
    // can while still leaving the separator and one character.
    expect(await res.json()).toEqual({ a: 'foo-bar', b: 'baz' });
  });

  it('needs the separator to be there', async () => {
    const base = await boot(ParamModule);
    expect((await fetch(`${base}/x/foo`)).status).toBe(404);
  });

  it('handles a literal prefix and a dot separator', async () => {
    const base = await boot(ParamModule);
    expect(await (await fetch(`${base}/v1.2`)).json()).toEqual({
      major: '1',
      minor: '2',
    });
    expect(await (await fetch(`${base}/v10.20`)).json()).toEqual({
      major: '10',
      minor: '20',
    });
  });

  it('leaves an ordinary single-param segment alone', async () => {
    const base = await boot(ParamModule);
    expect(await (await fetch(`${base}/one/42`)).json()).toEqual({ id: '42' });
  });
});

// ── L8 / L10 / L11 / L14 ────────────────────────────────────────────────────

@Controller()
class MiscController {
  @Get('cookie')
  cookie(@Res() res: BunResponse) {
    res.cookie('a', 'b', { maxAge: 60_000 });
    res.cookie('c', 'd', { maxAge: 60_000, expires: new Date(Date.UTC(2030, 0, 1)) });
    res.cookie('e', 'f');
    res.json({ ok: true });
  }

  @Post('form')
  form(@Body() body: unknown) {
    return { body };
  }

  @Get('host')
  host(@Req() req: BunRequest) {
    return { hostname: req.hostname };
  }

  @Get('ping')
  ping() {
    return { ok: true };
  }
}

@Module({ controllers: [MiscController] })
class MiscModule {}

describe('L8 — maxAge implies Expires', () => {
  it('emits both attributes, and lets maxAge override expires', async () => {
    const base = await boot(MiscModule);
    const res = await fetch(`${base}/cookie`);
    await res.arrayBuffer();
    const cookies = res.headers.getSetCookie();

    expect(cookies[0]).toContain('Max-Age=60');
    expect(cookies[0]).toContain('Expires=');
    // Express recomputes `expires` from `maxAge` rather than honouring both.
    expect(cookies[1]).toContain('Max-Age=60');
    expect(cookies[1]).not.toContain('2030');
    // No maxAge, no expires.
    expect(cookies[2]).toBe('e=f; Path=/');
  });
});

describe('L10 — duplicate keys in a urlencoded body', () => {
  it('collects them into an array, as the query parser does', async () => {
    const base = await boot(MiscModule);
    const res = await fetch(`${base}/form`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=1&a=2&b=3',
    });
    expect(await res.json()).toEqual({ body: { a: ['1', '2'], b: '3' } });
  });
});

describe('L11 — hostname from an IPv6 Host header', () => {
  it('keeps the brackets and drops the port', async () => {
    const base = await boot(MiscModule);
    const raw = await rawRequest(base, [
      'GET /host HTTP/1.1',
      'Host: [::1]:1234',
      'Connection: close',
    ]);
    expect(raw.slice(raw.indexOf('\r\n\r\n') + 4)).toBe('{"hostname":"[::1]"}');
  });

  it('still drops the port from a plain host', async () => {
    const base = await boot(MiscModule);
    const raw = await rawRequest(base, [
      'GET /host HTTP/1.1',
      'Host: example.test:8080',
      'Connection: close',
    ]);
    expect(raw).toContain('{"hostname":"example.test"}');
  });
});

describe('L9 — enableCors() after listen()', () => {
  it('takes effect on a server already serving native routes', async () => {
    const base = await boot(MiscModule);
    const before = await fetch(`${base}/ping`, { headers: { origin: 'https://x.test' } });
    await before.arrayBuffer();
    expect(before.headers.get('access-control-allow-origin')).toBeNull();

    (app as any).enableCors({ origin: true });

    const after = await fetch(`${base}/ping`, { headers: { origin: 'https://x.test' } });
    await after.arrayBuffer();
    expect(after.headers.get('access-control-allow-origin')).toBe('https://x.test');
  });
});

describe('L14 — both dispatchers use the registered error handler', () => {
  for (const [label, withMiddleware] of DISPATCHERS) {
    it(`routes next(err) through setErrorHandler — ${label}`, async () => {
      const seen: string[] = [];
      const base = await boot(MiscModule, a => {
        if (withMiddleware) passthrough(a);
      });
      // After boot: Nest installs its *own* error handler during `listen()`,
      // so anything set before that is overwritten.
      const adapter = (app as any).getHttpAdapter();
      adapter.setErrorHandler((err: Error, _req: unknown, res: BunResponse) => {
        seen.push(err.message);
        res.status(418).json({ handled: err.message });
      });
      // Registered straight on the adapter so the error escapes rather than
      // being caught by Nest's own per-route proxy.
      adapter.get('/raw-boom', (_req: BunRequest, _res: BunResponse, next?: Function) =>
        next?.(new Error('from next')),
      );

      const res = await fetch(`${base}/raw-boom`);
      expect(res.status).toBe(418);
      expect(await res.json()).toEqual({ handled: 'from next' });
      expect(seen).toEqual(['from next']);
    });

    it(`routes a thrown error through setErrorHandler — ${label}`, async () => {
      const base = await boot(MiscModule, a => {
        if (withMiddleware) passthrough(a);
      });
      const adapter = (app as any).getHttpAdapter();
      adapter.setErrorHandler((err: Error, _req: unknown, res: BunResponse) => {
        res.status(418).json({ handled: err.message });
      });
      adapter.get('/raw-throw', () => {
        throw new Error('thrown');
      });

      const res = await fetch(`${base}/raw-throw`);
      expect(res.status).toBe(418);
      expect(await res.json()).toEqual({ handled: 'thrown' });
    });
  }
});

// ── L13 ─────────────────────────────────────────────────────────────────────

@Controller()
class SlowController {
  @Get('slow')
  async slow() {
    await Bun.sleep(300);
    return { done: true };
  }
}

@Module({ controllers: [SlowController] })
class SlowModule {}

describe('L13 — close() waits for the server to stop', () => {
  it('does not resolve before an in-flight request finishes', async () => {
    const base = await boot(SlowModule);
    const inflight = fetch(`${base}/slow`).then(r => r.json());
    await Bun.sleep(50);

    const started = performance.now();
    await app?.close();
    const elapsed = performance.now() - started;
    app = null;

    // The request needs ~250 ms more; `stop()`'s promise settles once it has
    // drained. Dropping that promise, as this used to, made close() return in
    // about a millisecond.
    expect(elapsed).toBeGreaterThan(150);
    expect(await inflight).toEqual({ done: true });
  });
});

// ── L4 ──────────────────────────────────────────────────────────────────────

const abnormalErrors: Error[] = [];

@WebSocketGateway()
class ErrorGateway {
  handleConnection(client: { on(event: string, listener: (e: Error) => void): unknown }) {
    client.on('error', err => abnormalErrors.push(err));
  }

  @SubscribeMessage('noop')
  noop() {
    return { event: 'noop', data: null };
  }
}

describe('L4 — an abnormal WebSocket close raises an error', () => {
  const openSocket = (url: string) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(ws), { once: true });
      ws.addEventListener('error', reject as never, { once: true });
    });

  async function bootWs() {
    const moduleRef = await Test.createTestingModule({
      providers: [ErrorGateway],
    }).compile();
    const created = moduleRef.createNestApplication(new BunHttpAdapter(), {
      logger: false,
    });
    created.useWebSocketAdapter(new BunWsAdapter(created));
    await created.init();
    await created.listen(0, '127.0.0.1');
    app = created as never;
    return `ws://127.0.0.1:${created.getHttpServer().address().port}/`;
  }

  it('stays quiet on a normal close', async () => {
    abnormalErrors.length = 0;
    const url = await bootWs();
    const ws = await openSocket(url);
    ws.close(1000, 'bye');
    await Bun.sleep(120);
    expect(abnormalErrors).toEqual([]);
  });

  it('emits one for a close with an abnormal code', async () => {
    abnormalErrors.length = 0;
    const url = await bootWs();
    const ws = await openSocket(url);
    // Bun's WebSocketHandler has no `error` callback at all, so a failed socket
    // only ever shows up as a close code — which is what this derives from.
    ws.close(3000, 'kaboom');
    await Bun.sleep(120);
    expect(abnormalErrors).toHaveLength(1);
    expect(abnormalErrors[0].message).toContain('3000');
  });
});

// ── L7 ──────────────────────────────────────────────────────────────────────

describe('L7 — per-method route index', () => {
  // The index splits routes into a bucket per verb plus one for `ALL`, and
  // merges the two on lookup. Merging is the whole risk: candidates must still
  // come back in *registration* order, because that is the order the chain
  // runs them in and the order a `next()` fall-through depends on.
  // Runs on both dispatchers on purpose: the native map collapses a path that
  // has an `@All()` into one function route and rebuilds the chain itself, and
  // it used to rebuild it as "every method-specific handler, then every ALL
  // handler" — a different order from the manual dispatcher's. Found by this
  // test while merging the buckets; recorded as N4 in AUDIT.md.
  for (const [label, withMiddleware] of DISPATCHERS) {
    it(`preserves registration order across ALL and method-specific routes — ${label}`, async () => {
      const base = await boot(MiscModule, a => {
        if (withMiddleware) passthrough(a);
      });
      const adapter = (app as any).getHttpAdapter();
      const seen: string[] = [];
      const step =
        (tag: string) => (_req: BunRequest, _res: BunResponse, next?: Function) => {
          seen.push(tag);
          next?.();
        };

      adapter.get('/chain', step('get-1'));
      adapter.all('/chain', step('all-1'));
      adapter.get('/chain', step('get-2'));
      adapter.all('/chain', step('all-2'));
      adapter.get('/chain', (_req: BunRequest, res: BunResponse) => {
        res.json({ seen });
      });

      const res = await fetch(`${base}/chain`);
      expect(await res.json()).toEqual({
        seen: ['get-1', 'all-1', 'get-2', 'all-2'],
      });
    });
  }

  it('does not offer one verb’s routes to another', async () => {
    const base = await boot(MiscModule);
    const adapter = (app as any).getHttpAdapter();
    adapter.post('/only-post', (_req: BunRequest, res: BunResponse) =>
      res.json({ ok: 1 }),
    );

    expect((await fetch(`${base}/only-post`)).status).toBe(404);
    expect((await fetch(`${base}/only-post`, { method: 'POST' })).status).toBe(200);
  });

  it('still falls back from HEAD to the GET handlers', async () => {
    const base = await boot(MiscModule);
    const res = await fetch(`${base}/ping`, { method: 'HEAD' });
    expect(res.status).toBe(200);
  });
});
