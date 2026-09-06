import { afterEach, describe, expect, it } from 'bun:test';
import { Controller, Get, Module, Sse } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Observable, interval, map } from 'rxjs';
import { BunHttpAdapter } from '../../src';
import type { BunRequest, CorsOptions } from '../../src/adapters/bun-http-adapter';

// Regression tests for the 2026-09-06 audit (see AUDIT.md):
//
//   H4 — `Bun.serve` closes an idle connection after `idleTimeout` seconds
//        (10 by default, and the option is capped at 255, so it cannot simply
//        be raised for a stream that is *meant* to sit idle between events).
//        Every streaming upgrade now calls `server.timeout(req, 0)`.
//   H5 — `origin` as a `cors`-style `(requestOrigin, callback)` function — the
//        shape Nest's own documentation shows — resolved to nothing, so no
//        `Access-Control-Allow-Origin` was emitted at all.
//
// Both are asserted through a real `Bun.serve` and, where the two dispatchers
// can disagree, through each of them.

let app: { close(): Promise<unknown>; getHttpServer(): any } | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

/** Boot a Nest app on the Bun adapter; `configure` runs before `listen()`. */
async function boot(
  moduleClass: unknown,
  configure?: (app: any) => void,
): Promise<{ base: string; server: any }> {
  const created = await NestFactory.create(moduleClass as never, new BunHttpAdapter(), {
    logger: false,
  });
  configure?.(created);
  await created.listen(0);
  app = created as never;
  const server = created.getHttpServer();
  return { base: `http://localhost:${server.address().port}`, server };
}

/**
 * Record every `server.timeout(request, seconds)` the adapter makes, keeping the
 * real call so behaviour under test is the shipped behaviour. The property is
 * writable on Bun's `Server` (verified on 1.4.0).
 */
function spyOnTimeout(server: { bunServer: any }): number[] {
  const bun = server.bunServer;
  const seconds: number[] = [];
  const original = bun.timeout.bind(bun);
  bun.timeout = (request: Request, secs: number) => {
    seconds.push(secs);
    return original(request, secs);
  };
  return seconds;
}

// ── H4 ──────────────────────────────────────────────────────────────────────

@Controller()
class StreamController {
  @Sse('sse')
  sse(): Observable<unknown> {
    return interval(10).pipe(map(i => ({ data: { i } })));
  }

  @Get('buffered')
  buffered() {
    return { ok: true };
  }

  // Bypasses both the writable shim and `streamNodeReadable` — the response is
  // settled straight out of `reply()`, and it can still sit idle.
  @Get('web-stream')
  webStream() {
    return new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('chunk'));
      },
    });
  }
}

@Module({ controllers: [StreamController] })
class StreamModule {}

/** Forces the manual `fetch` dispatcher without changing anything else. */
@Module({ controllers: [StreamController] })
class StreamWithMiddlewareModule {
  configure(consumer: { apply(mw: unknown): { forRoutes(path: string): unknown } }) {
    consumer
      .apply((_req: unknown, _res: unknown, next: () => void) => next())
      .forRoutes('*');
  }
}

describe('H4 — streaming responses opt out of Bun’s idle timeout', () => {
  for (const [label, mod] of [
    ['native routes (fast path)', StreamModule],
    ['fetch dispatcher (slow path)', StreamWithMiddlewareModule],
  ] as const) {
    it(`disables the idle timer when a response starts streaming — ${label}`, async () => {
      const { base, server } = await boot(mod);
      const seconds = spyOnTimeout(server);

      const res = await fetch(`${base}/sse`);
      const reader = res.body!.getReader();
      await reader.read();
      await reader.cancel();

      // `0` is Bun's "never time this request out".
      expect(seconds).toContain(0);
    });

    it(`disables the idle timer for a returned ReadableStream — ${label}`, async () => {
      const { base, server } = await boot(mod);
      const seconds = spyOnTimeout(server);

      const res = await fetch(`${base}/web-stream`);
      const reader = res.body!.getReader();
      await reader.read();
      await reader.cancel();

      expect(seconds).toContain(0);
    });

    it(`leaves a buffered response on the default timer — ${label}`, async () => {
      const { base, server } = await boot(mod);
      const seconds = spyOnTimeout(server);

      const res = await fetch(`${base}/buffered`);
      expect(await res.json()).toEqual({ ok: true });

      // Nothing streamed, so nothing should have touched the idle timer.
      expect(seconds).toEqual([]);
    });
  }

  // The real proof, and the reason the spy above is not enough: it takes longer
  // than Bun's 10 s default to observe. Opt in with `RUN_SLOW_TESTS=1 bun test`.
  // Measured on Bun 1.4.0: without the fix the server closes the connection at
  // 12.0 s and logs "Bun.serve() timed out a request after 10 seconds".
  const slow = process.env.RUN_SLOW_TESTS === '1' ? it : it.skip;
  slow(
    'keeps an idle SSE connection open past the 10 s default',
    async () => {
      @Controller()
      class OneEventController {
        @Sse('quiet')
        quiet(): Observable<unknown> {
          // One event, then silence — the shape of every heartbeat-less feed.
          return new Observable(sub => {
            sub.next({ data: 'hello' });
          });
        }
      }
      @Module({ controllers: [OneEventController] })
      class OneEventModule {}

      const { base } = await boot(OneEventModule);
      const res = await fetch(`${base}/quiet`);
      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('hello');

      await Bun.sleep(13_000);

      // Still ours to cancel — the server has not closed it underneath us.
      const raced = await Promise.race([
        reader.read().then(() => 'closed' as const),
        Bun.sleep(200).then(() => 'open' as const),
      ]);
      expect(raced).toBe('open');
      await reader.cancel();
    },
    20_000,
  );
});

// ── H5 ──────────────────────────────────────────────────────────────────────

@Controller()
class CorsController {
  @Get('ping')
  ping() {
    return { ok: true };
  }
}

@Module({ controllers: [CorsController] })
class CorsModule {}

async function originHeaderFor(
  options: CorsOptions,
  requestOrigin = 'https://allowed.example',
): Promise<string | null> {
  const { base } = await boot(CorsModule, a => a.enableCors(options));
  const res = await fetch(`${base}/ping`, { headers: { origin: requestOrigin } });
  await res.arrayBuffer();
  return res.headers.get('access-control-allow-origin');
}

describe('H5 — enableCors({ origin }) function shapes', () => {
  it('resolves the cors-package callback form used in the Nest docs', async () => {
    expect(await originHeaderFor({ origin: (_origin, cb) => cb(null, true) })).toBe(
      'https://allowed.example',
    );
  });

  it('omits the header when the callback denies', async () => {
    expect(
      await originHeaderFor({ origin: (_origin, cb) => cb(null, false) }),
    ).toBeNull();
  });

  it('omits the header when the callback reports an error', async () => {
    expect(
      await originHeaderFor({ origin: (_o, cb) => cb(new Error('nope'), true) }),
    ).toBeNull();
  });

  it('hands the callback the request Origin, not the request object', async () => {
    const seen: unknown[] = [];
    expect(
      await originHeaderFor({
        origin: (requestOrigin, cb) => {
          seen.push(requestOrigin);
          cb(null, requestOrigin === 'https://allowed.example');
        },
      }),
    ).toBe('https://allowed.example');
    expect(seen).toEqual(['https://allowed.example']);
  });

  it('resolves a list returned through the callback', async () => {
    expect(
      await originHeaderFor({
        origin: (_o, cb) => cb(null, [/\.example$/, 'https://other.test']),
      }),
    ).toBe('https://allowed.example');
  });

  it('still supports the adapter’s one-argument (req) => origin form', async () => {
    // The parameter is annotated on purpose: `origin` is a union of two
    // function types with different arities, and TypeScript declines to pick a
    // contextual signature out of that, so a bare `req =>` is an implicit
    // `any` for consumers compiling with `noImplicitAny`.
    expect(
      await originHeaderFor({
        origin: (req: BunRequest) => req.path === '/ping',
      }),
    ).toBe('https://allowed.example');
  });

  it('warns instead of throwing when the callback never fires', async () => {
    expect(
      await originHeaderFor({
        // A caller doing an async allowlist lookup: nothing to emit, but the
        // request must still be served. Warned about once per process.
        origin: (_origin, _cb) => {},
      }),
    ).toBeNull();
  });

  it('does not emit a header when a one-argument function throws', async () => {
    expect(
      await originHeaderFor({
        origin: () => {
          throw new Error('boom');
        },
      }),
    ).toBeNull();
  });

  it('keeps echoing the Origin for credentials + wildcard', async () => {
    expect(await originHeaderFor({ origin: '*', credentials: true })).toBe(
      'https://allowed.example',
    );
  });
});
