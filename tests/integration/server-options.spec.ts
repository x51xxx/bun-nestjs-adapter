/**
 * Tests for BunHttpAdapter construction options forwarded to Bun.serve
 * (maxRequestBodySize) and the connection-info shims (req.ip / req.ips /
 * req.protocol / req.secure, with and without trustProxy).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Controller, Get, Module, Post, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BunHttpAdapter, BunHttpAdapterOptions } from '../../src';

@Controller()
class WhoAmIController {
  @Get('whoami')
  whoami(@Req() req: any) {
    return {
      ip: req.ip,
      ips: req.ips,
      protocol: req.protocol,
      secure: req.secure,
    };
  }

  @Post('echo')
  echo(@Req() req: any) {
    return { len: JSON.stringify(req.body ?? null).length };
  }
}

@Module({ controllers: [WhoAmIController] })
class WhoAmIModule {}

async function boot(options?: BunHttpAdapterOptions) {
  const moduleRef = await Test.createTestingModule({
    imports: [WhoAmIModule],
  }).compile();
  const app = moduleRef.createNestApplication(new BunHttpAdapter(options), {
    logger: false,
  });
  await app.init();
  await app.listen(0, '127.0.0.1');
  const addr = app.getHttpServer().address();
  return { app, baseUrl: `http://127.0.0.1:${addr.port}` };
}

describe('platform-bun :: connection info (default, no trustProxy)', () => {
  let ctx: { app: any; baseUrl: string };
  beforeAll(async () => {
    ctx = await boot();
  });
  afterAll(async () => ctx.app.close());

  it('reports the real socket peer as req.ip', async () => {
    const res = await fetch(`${ctx.baseUrl}/whoami`);
    const body = await res.json();
    expect(body.ip).toBe('127.0.0.1');
    expect(body.ips).toEqual([]);
    expect(body.protocol).toBe('http');
    expect(body.secure).toBe(false);
  });

  it('ignores x-forwarded-for when trustProxy is off', async () => {
    const res = await fetch(`${ctx.baseUrl}/whoami`, {
      headers: { 'x-forwarded-for': '8.8.8.8, 9.9.9.9' },
    });
    const body = await res.json();
    expect(body.ip).toBe('127.0.0.1');
    expect(body.ips).toEqual([]);
  });
});

describe('platform-bun :: connection info (trustProxy on)', () => {
  let ctx: { app: any; baseUrl: string };
  beforeAll(async () => {
    ctx = await boot({ trustProxy: true });
  });
  afterAll(async () => ctx.app.close());

  it('honours x-forwarded-for / x-forwarded-proto', async () => {
    const res = await fetch(`${ctx.baseUrl}/whoami`, {
      headers: {
        'x-forwarded-for': '8.8.8.8, 9.9.9.9',
        'x-forwarded-proto': 'https',
      },
    });
    const body = await res.json();
    expect(body.ip).toBe('8.8.8.8');
    expect(body.ips).toEqual(['8.8.8.8', '9.9.9.9']);
    expect(body.protocol).toBe('https');
    expect(body.secure).toBe(true);
  });
});

describe('platform-bun :: maxRequestBodySize', () => {
  let ctx: { app: any; baseUrl: string };
  beforeAll(async () => {
    ctx = await boot({ maxRequestBodySize: 32 });
  });
  afterAll(async () => ctx.app.close());

  it('accepts a body under the limit', async () => {
    const res = await fetch(`${ctx.baseUrl}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    expect(res.status).toBe(201);
  });

  it('rejects a body over the limit with 413', async () => {
    const res = await fetch(`${ctx.baseUrl}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: 'x'.repeat(500) }),
    });
    expect(res.status).toBe(413);
  });
});
