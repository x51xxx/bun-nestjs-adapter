/**
 * Cookie parsing (Bun.CookieMap-backed) + Express-compatible res.cookie()
 * serialization round-trip, including signed and JSON (`j:`) cookies.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Controller, Get, Module, Req, Res } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BunHttpAdapter } from '../../src';

const SECRET = 'cookie-secret-123';

@Controller()
class CookieController {
  @Get('set')
  set(@Res() res: any) {
    res.cookie('plain', 'hello world');
    res.cookie('obj', { a: 1, b: 'x' });
    res.cookie('token', 'sekret', { signed: true });
    res.json({ done: true });
  }

  @Get('read')
  read(@Req() req: any) {
    return { cookies: req.cookies ?? {}, signed: req.signedCookies ?? {} };
  }
}

@Module({ controllers: [CookieController] })
class CookieModule {}

let app: any;
let baseUrl: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [CookieModule],
  }).compile();
  app = moduleRef.createNestApplication(new BunHttpAdapter(), { logger: false });
  app.getHttpAdapter().enableCookieParser(SECRET);
  await app.init();
  await app.listen(0, '127.0.0.1');
  const addr = app.getHttpServer().address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => app.close());

describe('platform-bun :: cookies', () => {
  it('parses a plain cookie via Bun.CookieMap', async () => {
    const res = await fetch(`${baseUrl}/read`, {
      headers: { cookie: 'session=abc123; lang=en' },
    });
    const body = await res.json();
    expect(body.cookies.session).toBe('abc123');
    expect(body.cookies.lang).toBe('en');
  });

  it('percent-decodes cookie values', async () => {
    const res = await fetch(`${baseUrl}/read`, {
      headers: { cookie: 'q=hello%20world%21' },
    });
    expect((await res.json()).cookies.q).toBe('hello world!');
  });

  it('round-trips plain, JSON and signed cookies through set → read', async () => {
    const setRes = await fetch(`${baseUrl}/set`);
    const setCookies = setRes.headers.getSetCookie();
    expect(setCookies.length).toBe(3);

    // Replay the Set-Cookie name=value pairs back as a Cookie header.
    const cookieHeader = setCookies.map(c => c.split(';', 1)[0]).join('; ');
    const readRes = await fetch(`${baseUrl}/read`, {
      headers: { cookie: cookieHeader },
    });
    const body = await readRes.json();
    expect(body.cookies.plain).toBe('hello world');
    expect(body.cookies.obj).toEqual({ a: 1, b: 'x' });
    // Signed cookie must verify and land in signedCookies, not cookies.
    expect(body.signed.token).toBe('sekret');
    expect(body.cookies.token).toBeUndefined();
  });

  it('drops a signed cookie with a tampered signature', async () => {
    const setRes = await fetch(`${baseUrl}/set`);
    const token = setRes.headers
      .getSetCookie()
      .find(c => c.startsWith('token='))!
      .split(';', 1)[0];
    const tampered = `${token}XYZ`; // corrupt the signature tail
    const readRes = await fetch(`${baseUrl}/read`, {
      headers: { cookie: tampered },
    });
    const body = await readRes.json();
    expect(body.signed.token).toBeUndefined();
  });
});
