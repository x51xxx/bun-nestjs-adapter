/**
 * Brotli (br) compression + q-aware Accept-Encoding negotiation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Controller, Get, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BunHttpAdapter } from '../../src';

const BIG = 'lorem ipsum '.repeat(500);

@Controller()
class BrotliController {
  @Get('big')
  big() {
    return { value: BIG };
  }
}

@Module({ controllers: [BrotliController] })
class BrotliModule {}

let app: any;
let baseUrl: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [BrotliModule] }).compile();
  app = moduleRef.createNestApplication(new BunHttpAdapter({ compression: true }), {
    logger: false,
  });
  await app.init();
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;
});

afterAll(async () => app.close());

describe('platform-bun :: brotli compression', () => {
  it('compresses with br when the client only accepts br', async () => {
    const res = await fetch(`${baseUrl}/big`, { headers: { 'accept-encoding': 'br' } });
    expect(res.headers.get('content-encoding')).toBe('br');
    expect((await res.json()).value).toBe(BIG);
  });

  it('prefers br over gzip when both are accepted at equal q', async () => {
    const res = await fetch(`${baseUrl}/big`, {
      headers: { 'accept-encoding': 'gzip, deflate, br' },
    });
    expect(res.headers.get('content-encoding')).toBe('br');
  });

  it('falls back to gzip when br is not accepted', async () => {
    const res = await fetch(`${baseUrl}/big`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.headers.get('content-encoding')).toBe('gzip');
  });

  it('honours q-values (br;q=0 disables it)', async () => {
    const res = await fetch(`${baseUrl}/big`, {
      headers: { 'accept-encoding': 'br;q=0, gzip;q=1.0' },
    });
    expect(res.headers.get('content-encoding')).toBe('gzip');
  });
});
