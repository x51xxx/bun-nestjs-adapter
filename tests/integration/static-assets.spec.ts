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
});
