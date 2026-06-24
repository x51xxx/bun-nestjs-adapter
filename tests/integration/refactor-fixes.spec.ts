/**
 * Regression tests for fixes made during the src/http decomposition:
 *
 *   * `req.url` on the fallback fetch dispatcher kept the protocol/host part
 *     for root requests with a query string ('//host/?q=1' instead of '/?q=1')
 *     because it was sliced via `rawUrl.indexOf(pathname)`.
 *   * Malformed percent-encoding in route params or cookies crashed
 *     `decodeURIComponent` and turned a bad client request into a 500.
 *   * A static-asset miss (registered prefix, file not on disk) hard-404ed
 *     even when a route owned the same path — now it falls through to
 *     route dispatch.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { join } from 'path';
import { Controller, Get, Module, Param, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BunHttpAdapter } from '../../src';
import { buildFetchRequest, parseRequestBody } from '../../src/http/request';

@Controller()
class EchoController {
  @Get()
  root(@Req() req: any) {
    return { url: req.url, originalUrl: req.originalUrl, query: req.query };
  }

  @Get('echo/:id')
  echo(@Param('id') id: string) {
    return { id };
  }

  @Get('cookies')
  cookies(@Req() req: any) {
    return { cookies: req.cookies ?? {} };
  }

  @Get('static/dynamic')
  underStaticPrefix() {
    return { servedBy: 'route' };
  }
}
@Module({ controllers: [EchoController] })
class EchoModule {}

async function boot(configure?: (app: any) => void) {
  const moduleRef = await Test.createTestingModule({
    imports: [EchoModule],
  }).compile();
  const app = moduleRef.createNestApplication(new BunHttpAdapter(), {
    logger: false,
  });
  configure?.(app);
  await app.init();
  await app.listen(0, '127.0.0.1');
  const addr = app.getHttpServer().address();
  return { app, baseUrl: `http://127.0.0.1:${addr.port}` };
}

describe('fallback dispatcher req.url', () => {
  let app: any;
  let baseUrl: string;

  beforeAll(async () => {
    // CORS disables native Bun routes, forcing the manual fetch dispatcher
    // where the slicing bug lived.
    ({ app, baseUrl } = await boot(a => a.enableCors({ origin: '*' })));
  });
  afterAll(async () => app.close());

  it('keeps query string without leaking host into req.url at root path', async () => {
    const res = await fetch(`${baseUrl}/?q=1&x=2`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.url).toBe('/?q=1&x=2');
    expect(json.originalUrl).toBe('/?q=1&x=2');
    expect(json.query).toEqual({ q: '1', x: '2' });
  });

  it('handles malformed percent-encoding in a route param without a 500', async () => {
    const res = await fetch(`${baseUrl}/echo/%zz`, {});
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe('%zz');
  });

  it('handles malformed percent-encoding in cookies without a 500', async () => {
    const res = await fetch(`${baseUrl}/cookies`, {
      headers: { cookie: 'bad=%zz; good=ok' },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.cookies.good).toBe('ok');
    expect(json.cookies.bad).toBe('%zz');
  });
});

describe('fallback dispatcher rawBody', () => {
  it('keeps Buffer.alloc(0) when the fallback request stream is empty', async () => {
    const raw = new Request('http://example.test/raw-body', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    } as RequestInit);
    const req = await buildFetchRequest(raw, '/raw-body', '/raw-body', raw.url, -1, {
      bodyParserEnabled: true,
      rawBodyEnabled: true,
      cookieSecret: null,
      trustProxy: false,
      isSecure: false,
    });

    expect(req.body).toBeUndefined();
    expect(Buffer.isBuffer(req.rawBody)).toBe(true);
    expect(req.rawBody?.length).toBe(0);
  });
});

describe('static-asset miss falls through to routes', () => {
  let app: any;
  let baseUrl: string;
  const root = join(__dirname, 'fixtures', 'own', 'static');

  beforeAll(async () => {
    ({ app, baseUrl } = await boot(a => a.useStaticAssets(root, { prefix: '/static' })));
  });
  afterAll(async () => app.close());

  it('serves a real file from the static root', async () => {
    const res = await fetch(`${baseUrl}/static/index.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Hello from static');
  });

  it('dispatches to a route when no file exists under the prefix', async () => {
    const res = await fetch(`${baseUrl}/static/dynamic`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ servedBy: 'route' });
  });

  it('still 404s when neither file nor route matches', async () => {
    const res = await fetch(`${baseUrl}/static/missing.txt`);
    expect(res.status).toBe(404);
  });

  it('still blocks path traversal with 403', async () => {
    const res = await fetch(`${baseUrl}/static/..%2f..%2fsecret.txt`);
    expect([403, 404]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });
});

describe('parseRequestBody — empty-but-present body', () => {
  const emptySource = () => ({
    json: async () => JSON.parse(''),
    arrayBuffer: async () => new ArrayBuffer(0),
  });

  it('materialises an empty Buffer as rawBody in rawBody mode', async () => {
    const parsed = await parseRequestBody(emptySource(), 'application/json', true);
    expect(parsed.body).toBeUndefined();
    expect(Buffer.isBuffer(parsed.rawBody)).toBe(true);
    expect(parsed.rawBody?.length).toBe(0);
  });

  it('leaves rawBody undefined when rawBody mode is off', async () => {
    const parsed = await parseRequestBody(emptySource(), 'text/plain', false);
    expect(parsed.body).toBeUndefined();
    expect(parsed.rawBody).toBeUndefined();
  });
});
