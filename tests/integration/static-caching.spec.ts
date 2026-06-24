/**
 * Static-asset conditional requests, byte ranges and cache headers.
 * `data.json` in the fixture dir is 31 bytes: {"static":true,"server":"bun"}
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { join } from 'path';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BunHttpAdapter } from '../../src';

@Module({})
class EmptyModule {}

describe('platform-bun :: static caching & ranges', () => {
  let app: any;
  let baseUrl: string;
  const root = join(__dirname, 'fixtures', 'own', 'static');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EmptyModule],
    }).compile();
    app = moduleRef.createNestApplication(new BunHttpAdapter(), { logger: false });
    app.useStaticAssets(root, { prefix: '/static', maxAge: 3600 });
    await app.init();
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => app.close());

  it('emits ETag, Last-Modified, Accept-Ranges and Cache-Control', async () => {
    const res = await fetch(`${baseUrl}/static/data.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBeTruthy();
    expect(res.headers.get('last-modified')).toBeTruthy();
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('returns 304 for a matching If-None-Match', async () => {
    const first = await fetch(`${baseUrl}/static/data.json`);
    const etag = first.headers.get('etag')!;
    const res = await fetch(`${baseUrl}/static/data.json`, {
      headers: { 'if-none-match': etag },
    });
    expect(res.status).toBe(304);
    expect((await res.text()).length).toBe(0);
  });

  it('returns 304 for a fresh If-Modified-Since', async () => {
    const res = await fetch(`${baseUrl}/static/data.json`, {
      headers: { 'if-modified-since': new Date(Date.now() + 60_000).toUTCString() },
    });
    expect(res.status).toBe(304);
  });

  it('serves a byte range as 206 with Content-Range', async () => {
    const res = await fetch(`${baseUrl}/static/data.json`, {
      headers: { range: 'bytes=0-8' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-8/31');
    expect(res.headers.get('content-length')).toBe('9');
    const text = await res.text();
    expect(text).toBe('{"static"');
    expect(text.length).toBe(9);
  });

  it('serves a suffix range (last N bytes)', async () => {
    const res = await fetch(`${baseUrl}/static/data.json`, {
      headers: { range: 'bytes=-5' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 26-30/31');
    expect(await res.text()).toBe('un"}\n');
  });

  it('returns 416 for an unsatisfiable range', async () => {
    const res = await fetch(`${baseUrl}/static/data.json`, {
      headers: { range: 'bytes=999-1200' },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */31');
  });

  it('HEAD returns headers and no body with content-length', async () => {
    const res = await fetch(`${baseUrl}/static/data.json`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('31');
    expect((await res.text()).length).toBe(0);
  });
});
