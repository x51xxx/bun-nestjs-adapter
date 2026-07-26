/**
 * Regression tests for audit findings H1 / H2 / H3.
 *
 *   * H1 — the per-request `Promise<Response>` is now guaranteed to settle.
 *     Throwing after `res.write()` used to leave it pending forever (the
 *     client hung); `reply()` after `write()` used to drop the body silently.
 *   * H2 — SSE worked only on the native-routes fast path. The fallback
 *     `fetch` dispatcher built a request shim without `on`/`socket`, so
 *     `RouterResponseController.sse()` 500'd with
 *     "request.on is not a function".
 *   * H3 — both dispatchers now build the shim through one function, so the
 *     Node-isms and `req.ip` derivation can't drift apart again.
 *
 * Every case runs through BOTH dispatchers: `withMiddleware: false` keeps the
 * native-routes fast path, `true` forces the manual `fetch` path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  Controller,
  Get,
  Injectable,
  MiddlewareConsumer,
  Module,
  type NestMiddleware,
  Req,
  Res,
  Sse,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Observable } from 'rxjs';
import { BunHttpAdapter, type BunRequest, type BunResponse } from '../../src';

@Controller('h1')
class SettleController {
  @Get('throw-after-write')
  async throwAfterWrite(@Res() res: BunResponse) {
    (res as unknown as { write(c: string): boolean }).write('partial');
    throw new Error('exploded mid-stream');
  }

  @Get('reply-after-write')
  replyAfterWrite(@Res() res: BunResponse) {
    (res as unknown as { write(c: string): boolean }).write('first:');
    res.send({ tail: true });
  }

  @Get('ip')
  ip(@Req() req: BunRequest) {
    return { ip: req.ip };
  }

  @Sse('sse')
  sse() {
    return new Observable<{ data: { n: number } }>(subscriber => {
      subscriber.next({ data: { n: 1 } });
      subscriber.next({ data: { n: 2 } });
    });
  }
}

@Injectable()
class PassThroughMiddleware implements NestMiddleware {
  use(_req: unknown, _res: unknown, next: () => void) {
    next();
  }
}

@Module({ controllers: [SettleController] })
class FastModule {}

@Module({ controllers: [SettleController] })
class SlowModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(PassThroughMiddleware).forRoutes('*');
  }
}

/** Fail loudly instead of hanging the test runner when a response never settles. */
async function fetchOrTimeout(url: string, ms = 3000): Promise<Response> {
  return (await Promise.race([
    fetch(url),
    new Promise((_r, reject) =>
      setTimeout(() => reject(new Error(`response never settled (${url})`)), ms),
    ),
  ])) as Response;
}

for (const withMiddleware of [false, true]) {
  const label = withMiddleware ? 'fetch dispatcher' : 'native routes';

  describe(`audit H1/H2/H3 — ${label}`, () => {
    let app: Awaited<ReturnType<typeof bootstrap>>['app'];
    let base: string;

    async function bootstrap() {
      const moduleRef = await Test.createTestingModule({
        imports: [withMiddleware ? SlowModule : FastModule],
      }).compile();
      const app = moduleRef.createNestApplication(new BunHttpAdapter());
      await app.init();
      await app.listen(0);
      return { app };
    }

    beforeAll(async () => {
      ({ app } = await bootstrap());
      const address = (
        app.getHttpAdapter().getHttpServer() as unknown as {
          address(): { port: number };
        }
      ).address();
      base = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
      await app.close();
    });

    // ── H1 ────────────────────────────────────────────────────────────────
    it('throwing after res.write() terminates the request instead of hanging', async () => {
      // `write()` already committed the status line, so a 500 body is no longer
      // possible — the contract we can enforce is that the request *ends*.
      // Previously `_reject` resolved an already-settled promise (a no-op) and
      // left the ReadableStream open forever, hanging the connection.
      const res = await fetchOrTimeout(`${base}/h1/throw-after-write`);
      expect(res.status).toBe(200);
      // Body is truncated at whatever was written before the throw; nothing
      // the handler would have returned afterwards is appended.
      expect(await res.text()).toBe('partial');
    });

    it('stays healthy after a mid-stream failure', async () => {
      await fetchOrTimeout(`${base}/h1/throw-after-write`).then(r => r.text());
      const res = await fetchOrTimeout(`${base}/h1/reply-after-write`);
      expect(res.status).toBe(200);
    });

    it('replying after res.write() appends instead of dropping the body', async () => {
      const res = await fetchOrTimeout(`${base}/h1/reply-after-write`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('first:{"tail":true}');
    });

    // ── H2 ────────────────────────────────────────────────────────────────
    it('serves SSE', async () => {
      const res = await fetchOrTimeout(`${base}/h1/sse`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const reader = res.body!.getReader();
      const chunk = new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();
      expect(chunk).toContain('data: {"n":1}');
    });

    // ── H3 ────────────────────────────────────────────────────────────────
    it('exposes the Node-isms Nest core touches on the request shim', async () => {
      const res = await fetchOrTimeout(`${base}/h1/ip`);
      expect(res.status).toBe(200);
    });

    it('reports the real peer IP and ignores X-Forwarded-For by default', async () => {
      const res = await fetchOrTimeout(`${base}/h1/ip`);
      const direct = (await res.json()) as { ip: string };
      expect(direct.ip).toBe('127.0.0.1');

      const spoofed = await fetch(`${base}/h1/ip`, {
        headers: { 'x-forwarded-for': '9.9.9.9' },
      });
      // trustProxy is off — a client-supplied header must not become req.ip.
      expect(((await spoofed.json()) as { ip: string }).ip).toBe('127.0.0.1');
    });
  });
}

describe('audit H1b — notFoundHandler that delegates', () => {
  /**
   * The handler used to be called with a no-op `next`, so one that delegated
   * instead of writing left the response promise pending. It now receives a
   * real `next` that renders the built-in 404.
   */
  async function bootWithNotFound(handler: (...args: never[]) => unknown) {
    const moduleRef = await Test.createTestingModule({ imports: [FastModule] }).compile();
    const adapter = new BunHttpAdapter();
    const app = moduleRef.createNestApplication(adapter);
    await app.init();
    adapter.setNotFoundHandler(handler);
    await app.listen(0);
    const { port } = (
      app.getHttpAdapter().getHttpServer() as unknown as {
        address(): { port: number };
      }
    ).address();
    return { app, base: `http://127.0.0.1:${port}` };
  }

  it('falls back to the default 404 instead of hanging', async () => {
    const { app, base } = await bootWithNotFound(((
      _req: unknown,
      _res: unknown,
      next: () => void,
    ) => next()) as never);

    const res = await fetchOrTimeout(`${base}/nothing-here`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ statusCode: 404, message: 'Not Found' });
    await app.close();
  });

  it('does not double-settle when the handler writes and then rejects', async () => {
    const { app, base } = await bootWithNotFound(((_req: unknown, res: BunResponse) => {
      res.status(418).send({ teapot: true });
      return Promise.reject(new Error('late failure'));
    }) as never);

    const res = await fetchOrTimeout(`${base}/nothing-here`);
    // The write wins; the late rejection must not overwrite it with a 500.
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ teapot: true });
    await app.close();
  });
});

describe('audit H3 — setTrustProxy opt-in', () => {
  it('honours X-Forwarded-For only once explicitly enabled', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FastModule],
    }).compile();
    const adapter = new BunHttpAdapter();
    adapter.setTrustProxy();
    const app = moduleRef.createNestApplication(adapter);
    await app.init();
    await app.listen(0);
    const { port } = (
      app.getHttpAdapter().getHttpServer() as unknown as {
        address(): { port: number };
      }
    ).address();

    const res = await fetch(`http://127.0.0.1:${port}/h1/ip`, {
      headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' },
    });
    expect(((await res.json()) as { ip: string }).ip).toBe('9.9.9.9');
    await app.close();
  });
});
