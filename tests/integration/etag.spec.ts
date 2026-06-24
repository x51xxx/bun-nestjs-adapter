/**
 * Opt-in auto-ETag + conditional GET (304) for buffered dynamic responses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Controller, Get, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BunHttpAdapter, BunHttpAdapterOptions } from '../../src';

@Controller()
class EtagController {
  @Get('json')
  json() {
    return { hello: 'world', n: 42 };
  }

  @Get('text')
  text() {
    return 'plain body';
  }

  @Post('made')
  made() {
    return { created: true };
  }
}

@Module({ controllers: [EtagController] })
class EtagModule {}

async function boot(options?: BunHttpAdapterOptions) {
  const moduleRef = await Test.createTestingModule({ imports: [EtagModule] }).compile();
  const app = moduleRef.createNestApplication(new BunHttpAdapter(options), {
    logger: false,
  });
  await app.init();
  await app.listen(0, '127.0.0.1');
  return { app, baseUrl: `http://127.0.0.1:${app.getHttpServer().address().port}` };
}

describe('platform-bun :: auto ETag (weak)', () => {
  let ctx: { app: any; baseUrl: string };
  beforeAll(async () => {
    ctx = await boot({ etag: true });
  });
  afterAll(async () => ctx.app.close());

  it('sets a weak ETag on a JSON response', async () => {
    const res = await fetch(`${ctx.baseUrl}/json`);
    expect(res.headers.get('etag')).toMatch(/^W\/"/);
  });

  it('returns 304 for a matching If-None-Match', async () => {
    const first = await fetch(`${ctx.baseUrl}/json`);
    const etag = first.headers.get('etag')!;
    const second = await fetch(`${ctx.baseUrl}/json`, {
      headers: { 'if-none-match': etag },
    });
    expect(second.status).toBe(304);
    expect((await second.text()).length).toBe(0);
  });

  it('returns 200 with a fresh body when the ETag does not match', async () => {
    const res = await fetch(`${ctx.baseUrl}/json`, {
      headers: { 'if-none-match': 'W/"deadbeef"' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: 'world', n: 42 });
  });

  it('tags text responses too', async () => {
    const res = await fetch(`${ctx.baseUrl}/text`);
    expect(res.headers.get('etag')).toBeTruthy();
  });

  it('does not 304 a non-GET response', async () => {
    const res = await fetch(`${ctx.baseUrl}/made`, { method: 'POST' });
    expect(res.status).toBe(201);
    expect(res.headers.get('etag')).toBeNull();
  });
});

describe('platform-bun :: ETag strong + disabled', () => {
  it('emits a strong ETag when configured', async () => {
    const ctx = await boot({ etag: 'strong' });
    try {
      const res = await fetch(`${ctx.baseUrl}/json`);
      const etag = res.headers.get('etag')!;
      expect(etag.startsWith('W/')).toBe(false);
      expect(etag.startsWith('"')).toBe(true);
    } finally {
      await ctx.app.close();
    }
  });

  it('emits no ETag by default', async () => {
    const ctx = await boot();
    try {
      const res = await fetch(`${ctx.baseUrl}/json`);
      expect(res.headers.get('etag')).toBeNull();
    } finally {
      await ctx.app.close();
    }
  });
});
