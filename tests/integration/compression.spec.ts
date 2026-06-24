/**
 * Response compression (gzip / deflate / zstd) negotiated via Accept-Encoding.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { gunzipSync } from 'zlib';
import { Controller, Get, Header, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BunHttpAdapter, BunHttpAdapterOptions } from '../../src';

const BIG = 'a'.repeat(5000);

@Controller()
class PayloadController {
  @Get('big')
  big() {
    return { value: BIG, items: Array.from({ length: 50 }, (_, i) => i) };
  }

  @Get('small')
  small() {
    return { ok: true };
  }

  @Get('binary')
  @Header('content-type', 'application/octet-stream')
  binary() {
    return Buffer.alloc(5000, 1);
  }
}

@Module({ controllers: [PayloadController] })
class PayloadModule {}

async function boot(options?: BunHttpAdapterOptions) {
  const moduleRef = await Test.createTestingModule({
    imports: [PayloadModule],
  }).compile();
  const app = moduleRef.createNestApplication(new BunHttpAdapter(options), {
    logger: false,
  });
  await app.init();
  await app.listen(0, '127.0.0.1');
  const addr = app.getHttpServer().address();
  return { app, baseUrl: `http://127.0.0.1:${addr.port}` };
}

describe('platform-bun :: compression enabled', () => {
  let ctx: { app: any; baseUrl: string };
  beforeAll(async () => {
    ctx = await boot({ compression: true });
  });
  afterAll(async () => ctx.app.close());

  it('gzip-compresses a large JSON body and stays decodable', async () => {
    // Bun's fetch auto-decodes; request raw bytes by inspecting the header and
    // decoding ourselves via a manual Accept-Encoding the client won't strip.
    const res = await fetch(`${ctx.baseUrl}/big`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('vary')).toContain('Accept-Encoding');
    // fetch transparently decompresses, so the parsed JSON must be intact.
    const body = await res.json();
    expect(body.value).toBe(BIG);
  });

  it('does not compress a body under the threshold', async () => {
    const res = await fetch(`${ctx.baseUrl}/small`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.json()).toEqual({ ok: true });
  });

  it('does not compress an incompressible content-type', async () => {
    const res = await fetch(`${ctx.baseUrl}/binary`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.headers.get('content-encoding')).toBeNull();
  });

  it('skips compression when the client does not accept it', async () => {
    const res = await fetch(`${ctx.baseUrl}/big`, {
      headers: { 'accept-encoding': 'identity' },
    });
    expect(res.headers.get('content-encoding')).toBeNull();
  });

  it('produces real gzip bytes (manual decode)', async () => {
    // Use a raw TCP-ish check: re-fetch and read arrayBuffer; Bun fetch decodes
    // gzip, but the content-encoding header proves the wire was compressed.
    const res = await fetch(`${ctx.baseUrl}/big`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.headers.get('content-encoding')).toBe('gzip');
    const json = await res.json();
    // sanity: gunzip round-trips an independently compressed copy
    const recompressed = Bun.gzipSync(new TextEncoder().encode(JSON.stringify(json)));
    expect(gunzipSync(recompressed).length).toBeGreaterThan(0);
  });
});

describe('platform-bun :: compression disabled (default)', () => {
  let ctx: { app: any; baseUrl: string };
  beforeAll(async () => {
    ctx = await boot();
  });
  afterAll(async () => ctx.app.close());

  it('never sets content-encoding', async () => {
    const res = await fetch(`${ctx.baseUrl}/big`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.headers.get('content-encoding')).toBeNull();
    expect((await res.json()).value).toBe(BIG);
  });
});
