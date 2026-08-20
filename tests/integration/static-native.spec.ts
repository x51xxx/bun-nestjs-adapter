import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { connect } from 'net';
import { join } from 'path';
import { Controller, Get, Module, Param } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BunHttpAdapter } from '../../src';

// `{ dir }` routes are a Bun 1.4.0 feature; on an older runtime
// `useStaticAssets({ native: true })` degrades to the classic path and these
// assertions describe behaviour that cannot exist.
const NATIVE_SUPPORTED = Bun.semver.satisfies(Bun.version, '>=1.4.0');
const describeNative = NATIVE_SUPPORTED ? describe : describe.skip;

const ROOT = join(__dirname, 'fixtures', 'own', 'static');

@Controller()
class ShadowController {
  // Sits *under* a native static prefix on purpose: the whole point of the
  // native mode is that routes are consulted first.
  @Get('shadow/:name')
  shadow(@Param('name') name: string) {
    return { shadowedBy: 'route', name };
  }

  @Get('plain')
  plain() {
    return { ok: true };
  }
}

@Module({ controllers: [ShadowController] })
class AppModule {}

/**
 * `fetch()` normalises `%2e%2e` and `..` in the request target before the
 * request leaves the client, so a traversal attempt has to be written onto
 * the socket by hand to reach the server at all.
 */
function rawGet(baseUrl: string, target: string): Promise<number> {
  const port = Number(new URL(baseUrl).port);
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
      );
    });
    let buf = '';
    socket.on('data', chunk => {
      buf += chunk.toString();
    });
    socket.on('error', reject);
    socket.on('close', () => {
      const status = Number(buf.split(' ')[1]);
      if (Number.isNaN(status))
        return reject(new Error(`no status line in: ${buf.slice(0, 80)}`));
      resolve(status);
    });
  });
}

interface Harness {
  baseUrl: string;
  close(): Promise<void>;
  nativeRouteMap: boolean;
}

/**
 * Boots the same app twice: once clean (Bun's native route map owns
 * dispatch) and once with a no-op `use()` middleware, which forces the manual
 * `fetch` dispatcher. Every assertion below runs against both — a native
 * static root is only correct if the two agree.
 */
async function boot(withMiddleware: boolean): Promise<Harness> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication(new BunHttpAdapter(), { logger: false });
  if (withMiddleware) {
    app.use((_req: any, _res: any, next: any) => next());
  }
  app.useStaticAssets(ROOT, { prefix: '/static', native: true });
  app.useStaticAssets(ROOT, { prefix: '/shadow', native: true });
  await app.init();
  await app.listen(0, '127.0.0.1');
  const addr = app.getHttpServer().address();
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => app.close(),
    nativeRouteMap: app.getHttpServer().routes !== undefined,
  };
}

describeNative('platform-bun :: useStaticAssets({ native: true })', () => {
  let fast: Harness;
  let slow: Harness;

  beforeAll(async () => {
    fast = await boot(false);
    slow = await boot(true);
  });

  afterAll(async () => {
    await fast.close();
    await slow.close();
  });

  it('keeps the native route map alive for an app with static assets', () => {
    // The whole reason the option exists: a classic static root sets this to
    // undefined and drags every request through `handle()`.
    expect(fast.nativeRouteMap).toBe(true);
    expect(slow.nativeRouteMap).toBe(false);
  });

  for (const [label, h] of [
    ['native routes', () => fast],
    ['fetch dispatcher', () => slow],
  ] as [string, () => Harness][]) {
    describe(label, () => {
      it('serves a file with validators', async () => {
        const res = await fetch(`${h().baseUrl}/static/data.json`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('application/json');
        expect(res.headers.get('etag')).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
        expect(res.headers.get('last-modified')).toBeTruthy();
        expect(res.headers.get('accept-ranges')).toBe('bytes');
        expect(await res.json()).toEqual({ static: true, server: 'bun' });
      });

      it('answers a conditional request with 304 (If-None-Match)', async () => {
        const first = await fetch(`${h().baseUrl}/static/data.json`);
        await first.text();
        const etag = first.headers.get('etag')!;
        const res = await fetch(`${h().baseUrl}/static/data.json`, {
          headers: { 'if-none-match': etag },
        });
        expect(res.status).toBe(304);
        expect((await res.text()).length).toBe(0);
      });

      it('answers a conditional request with 304 (If-Modified-Since)', async () => {
        const first = await fetch(`${h().baseUrl}/static/data.json`);
        await first.text();
        const res = await fetch(`${h().baseUrl}/static/data.json`, {
          headers: { 'if-modified-since': first.headers.get('last-modified')! },
        });
        expect(res.status).toBe(304);
      });

      it('serves a byte range as 206', async () => {
        const res = await fetch(`${h().baseUrl}/static/data.json`, {
          headers: { range: 'bytes=0-4' },
        });
        expect(res.status).toBe(206);
        expect(res.headers.get('content-range')).toMatch(/^bytes 0-4\/\d+$/);
        expect((await res.text()).length).toBe(5);
      });

      it('serves index.html for the prefix root and for a subdirectory', async () => {
        const root = await fetch(`${h().baseUrl}/static/`);
        expect(root.status).toBe(200);
        expect(await root.text()).toContain('Hello from static');

        const sub = await fetch(`${h().baseUrl}/static/sub/`);
        expect(sub.status).toBe(200);
        expect(await sub.text()).toContain('nested index');
      });

      it('redirects a subdirectory without a trailing slash', async () => {
        const res = await fetch(`${h().baseUrl}/static/sub`, { redirect: 'manual' });
        expect(res.status).toBe(301);
        expect(res.headers.get('location')).toBe('/static/sub/');
      });

      it('hard-404s a miss instead of falling through to Nest', async () => {
        const res = await fetch(`${h().baseUrl}/static/nope.txt`);
        expect(res.status).toBe(404);
        // Nest's own 404 would be `{"message":"Cannot GET ...","statusCode":404}`;
        // the directory route answers first and answers empty.
        expect((await res.text()).length).toBe(0);
      });

      it('still renders Nest 404 outside any static prefix', async () => {
        const res = await fetch(`${h().baseUrl}/nowhere`);
        expect(res.status).toBe(404);
        expect(await res.json()).toMatchObject({ statusCode: 404 });
      });

      it('has no method gate — a POST gets the file', async () => {
        const res = await fetch(`${h().baseUrl}/static/data.json`, { method: 'POST' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ static: true, server: 'bun' });
      });

      it('strips the body from a HEAD', async () => {
        const res = await fetch(`${h().baseUrl}/static/data.json`, { method: 'HEAD' });
        expect(res.status).toBe(200);
        expect((await res.text()).length).toBe(0);
      });

      it('lets a route shadow a file underneath the prefix', async () => {
        const res = await fetch(`${h().baseUrl}/shadow/data.json`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ shadowedBy: 'route', name: 'data.json' });
      });

      it('never serves anything from outside the root', async () => {
        for (const target of [
          '/static/%2e%2e/%2e%2e/etc/hosts',
          '/static/..%2f..%2fetc/hosts',
          '/static/../../package.json',
          '/static/..%2f..%2fpackage.json',
        ]) {
          expect(await rawGet(h().baseUrl, target)).toBe(404);
        }
      });
    });
  }

  // The one place the two dispatchers disagree, and it is not ours to fix:
  // Bun resolves dot-segments in `Request.url` before the `fetch` callback
  // runs, so by the time the manual dispatcher sees the path the `%2e%2e` is
  // already collapsed. The native route matches the raw target and rejects it.
  // Neither reaches outside the root — the escape cases above cover that — so
  // this is a status difference on a path that stays inside `dir`.
  it('differs on an in-root dot-segment: 404 natively, collapsed by `fetch`', async () => {
    expect(await rawGet(fast.baseUrl, '/static/sub/%2e%2e/data.json')).toBe(404);
    expect(await rawGet(slow.baseUrl, '/static/sub/%2e%2e/data.json')).toBe(200);
  });

  it('produces identical validators on both dispatchers', async () => {
    const a = await fetch(`${fast.baseUrl}/static/data.json`);
    const b = await fetch(`${slow.baseUrl}/static/data.json`);
    await Promise.all([a.text(), b.text()]);
    expect(b.headers.get('etag')).toBe(a.headers.get('etag'));
    expect(b.headers.get('last-modified')).toBe(a.headers.get('last-modified'));
    expect(b.headers.get('content-type')).toBe(a.headers.get('content-type'));
  });
});
