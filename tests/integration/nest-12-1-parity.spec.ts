import { afterEach, describe, expect, it } from 'bun:test';
import {
  Controller,
  Get,
  Module,
  Req,
  Sse,
  VERSION_NEUTRAL,
  Version,
  VersioningType,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Observable } from 'rxjs';
import { BunHttpAdapter } from '../../src';
import { getMediaTypeVersion } from '../../src/http/versioning';

// Parity with the @nestjs/platform-express fixes that landed between v12.0.1
// and v12.1.2 (see the upstream commit named in each describe block).

let app: { close(): Promise<unknown>; getHttpServer(): any } | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

async function boot(
  moduleClass: unknown,
  configure?: (app: any) => void,
  options: Record<string, unknown> = {},
): Promise<string> {
  const created = await NestFactory.create(moduleClass as never, new BunHttpAdapter(), {
    logger: false,
    ...options,
  });
  configure?.(created);
  await created.listen(0, '127.0.0.1');
  app = created as never;
  return `http://127.0.0.1:${created.getHttpServer().address().port}`;
}

describe('MEDIA_TYPE versioning reads any Accept parameter (697ff89e0e)', () => {
  it('getMediaTypeVersion scans every media range and parameter', () => {
    expect(getMediaTypeVersion('application/json;v=2', 'v=')).toBe('2');
    expect(getMediaTypeVersion('application/json;q=0.9;v=2', 'v=')).toBe('2');
    expect(getMediaTypeVersion('application/json; v=2', 'v=')).toBe('2');
    expect(getMediaTypeVersion('text/html, application/json;v=3', 'v=')).toBe('3');
    expect(getMediaTypeVersion(['text/html', 'application/json;v=4'], 'v=')).toBe('4');
    expect(getMediaTypeVersion('application/json', 'v=')).toBeUndefined();
    expect(getMediaTypeVersion(undefined, 'v=')).toBeUndefined();
  });

  @Controller('cats')
  class CatsController {
    @Version('1')
    @Get()
    v1() {
      return 'v1';
    }

    @Version(['2', VERSION_NEUTRAL])
    @Get()
    v2() {
      return 'v2-or-neutral';
    }
  }

  @Module({ controllers: [CatsController] })
  class AppModule {}

  // A no-op `use()` forces the manual `fetch` dispatcher; without it the
  // versioned route chain sits in Bun's native route map.
  for (const [name, withMiddleware] of [
    ['native routes', false],
    ['fetch dispatcher', true],
  ] as const) {
    it(`routes a version that is not the first parameter — ${name}`, async () => {
      const base = await boot(AppModule, a => {
        if (withMiddleware) a.use((_q: unknown, _s: unknown, next: () => void) => next());
        a.enableVersioning({ type: VersioningType.MEDIA_TYPE, key: 'v=' });
      });
      const cases: Array<[string | undefined, number, string?]> = [
        ['application/json;v=1', 200, 'v1'],
        ['application/json;q=0.9;v=2', 200, 'v2-or-neutral'],
        ['text/html, application/json;v=1', 200, 'v1'],
        // The first match wins, as upstream's scan does.
        ['application/json;v=1, application/json;v=2', 200, 'v1'],
        // No version parameter at all → the VERSION_NEUTRAL handler.
        ['application/json', 200, 'v2-or-neutral'],
        [undefined, 200, 'v2-or-neutral'],
        ['application/json;v=9', 404],
      ];
      for (const [accept, status, body] of cases) {
        const res = await fetch(`${base}/cats`, {
          headers: accept === undefined ? {} : { accept },
        });
        expect(`${accept} → ${res.status}`).toBe(`${accept} → ${status}`);
        if (body !== undefined) expect(await res.text()).toBe(body);
      }
    });
  }
});

describe('forceCloseConnections', () => {
  let unsubscribed = false;

  @Controller()
  class SseController {
    @Sse('sse')
    sse() {
      return new Observable<{ data: number }>(subscriber => {
        let i = 0;
        const timer = setInterval(() => subscriber.next({ data: i++ }), 20);
        return () => {
          clearInterval(timer);
          unsubscribed = true;
        };
      });
    }
  }

  @Module({ controllers: [SseController] })
  class SseModule {}

  it('close() drops an open SSE connection and tears the stream down', async () => {
    unsubscribed = false;
    const base = await boot(SseModule, undefined, { forceCloseConnections: true });
    const res = await fetch(`${base}/sse`);
    const reader = res.body!.getReader();
    await reader.read();

    const closing = app!.close();
    app = null;
    const outcome = await Promise.race([
      closing.then(() => 'closed'),
      Bun.sleep(2000).then(() => 'hung'),
    ]);
    expect(outcome).toBe('closed');
    // The client side sees the stream end rather than hanging forever.
    await reader.read().catch(() => undefined);
    await Bun.sleep(20);
    expect(unsubscribed).toBe(true);
  });
});

describe('cookies', () => {
  @Controller()
  class CookieController {
    @Get('cookies')
    all(@Req() req: { cookies: Record<string, unknown> }) {
      return req.cookies;
    }
  }

  @Module({ controllers: [CookieController] })
  class CookieModule {}

  it('keeps the first value of a repeated cookie name, as cookie.parse does', async () => {
    const base = await boot(CookieModule);
    const res = await fetch(`${base}/cookies`, {
      headers: { cookie: 'theme=dark; lang=en%20US; theme=ignored' },
    });
    expect(await res.json()).toEqual({ theme: 'dark', lang: 'en US' });
  });
});
