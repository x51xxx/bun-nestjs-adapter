import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { join } from 'path';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BunHttpAdapter } from '../../src';

@Module({})
class EmptyModule {}

describe('platform-bun :: useStaticAssets', () => {
  let app: any;
  let baseUrl: string;
  const root = join(__dirname, 'fixtures', 'own', 'static');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EmptyModule],
    }).compile();
    app = moduleRef.createNestApplication(new BunHttpAdapter(), {
      logger: false,
    });
    app.useStaticAssets(root, { prefix: '/static' });
    await app.init();
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => app.close());

  it('serves index.html when requesting prefix root', async () => {
    const res = await fetch(`${baseUrl}/static/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Hello from static');
  });

  it('serves a static html file by direct path', async () => {
    const res = await fetch(`${baseUrl}/static/index.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Hello from static');
  });

  it('serves a json static asset with correct mime', async () => {
    const res = await fetch(`${baseUrl}/static/data.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toEqual({ static: true, server: 'bun' });
  });

  it('returns 404 for missing static asset', async () => {
    const res = await fetch(`${baseUrl}/static/missing.txt`);
    expect(res.status).toBe(404);
  });

  it('does not collide with non-prefixed paths', async () => {
    const res = await fetch(`${baseUrl}/other`);
    expect(res.status).toBe(404);
  });

  it('sends cache validators', async () => {
    const res = await fetch(`${baseUrl}/static/data.json`);
    await res.text();
    expect(res.headers.get('etag')).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    expect(res.headers.get('last-modified')).toBeTruthy();
    expect(res.headers.get('accept-ranges')).toBe('bytes');
  });

  it('answers If-None-Match with 304 and no body', async () => {
    const first = await fetch(`${baseUrl}/static/data.json`);
    await first.text();
    const res = await fetch(`${baseUrl}/static/data.json`, {
      headers: { 'if-none-match': first.headers.get('etag')! },
    });
    expect(res.status).toBe(304);
    expect((await res.text()).length).toBe(0);
    expect(res.headers.get('etag')).toBe(first.headers.get('etag'));
  });

  it('answers If-Modified-Since with 304', async () => {
    const first = await fetch(`${baseUrl}/static/data.json`);
    await first.text();
    const res = await fetch(`${baseUrl}/static/data.json`, {
      headers: { 'if-modified-since': first.headers.get('last-modified')! },
    });
    expect(res.status).toBe(304);
  });

  it('re-sends the file when the validator does not match', async () => {
    const res = await fetch(`${baseUrl}/static/data.json`, {
      headers: { 'if-none-match': 'W/"deadbeef-deadbeef"' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ static: true, server: 'bun' });
  });

  // `Range` is handled by Bun itself for a `Bun.file` body — it even rewrites
  // the `content-length` we set — but only from 1.4.0 on.
  const itRange = Bun.semver.satisfies(Bun.version, '>=1.4.0') ? it : it.skip;

  itRange('serves a byte range as 206', async () => {
    const res = await fetch(`${baseUrl}/static/data.json`, {
      headers: { range: 'bytes=0-4' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toMatch(/^bytes 0-4\/\d+$/);
    expect(res.headers.get('content-length')).toBe('5');
    expect((await res.text()).length).toBe(5);
  });

  itRange('agrees with the native mount about the validators', async () => {
    // Same file, same formula: a client that saw one mode revalidates against
    // the other instead of re-downloading.
    const moduleRef = await Test.createTestingModule({
      imports: [EmptyModule],
    }).compile();
    const nativeApp = moduleRef.createNestApplication(new BunHttpAdapter(), {
      logger: false,
    });
    nativeApp.useStaticAssets(root, { prefix: '/static', native: true });
    await nativeApp.init();
    await nativeApp.listen(0, '127.0.0.1');
    try {
      const nativeUrl = `http://127.0.0.1:${nativeApp.getHttpServer().address().port}`;
      const classic = await fetch(`${baseUrl}/static/data.json`);
      const native = await fetch(`${nativeUrl}/static/data.json`);
      await Promise.all([classic.text(), native.text()]);
      expect(native.headers.get('etag')).toBe(classic.headers.get('etag'));
      expect(native.headers.get('last-modified')).toBe(
        classic.headers.get('last-modified'),
      );
    } finally {
      await nativeApp.close();
    }
  });
});
