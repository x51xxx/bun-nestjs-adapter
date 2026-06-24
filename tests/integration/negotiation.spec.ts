/**
 * Content negotiation (req.accepts / is / range) and Express response helpers
 * (res.format, jsonp, attachment, location, vary, append).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Controller, Get, Module, Post, Req, Res } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BunHttpAdapter } from '../../src';

@Controller()
class NegController {
  @Get('accepts')
  accepts(@Req() req: any) {
    return {
      type: req.accepts('json', 'html'),
      enc: req.acceptsEncodings('gzip', 'br'),
      lang: req.acceptsLanguages('en', 'fr'),
    };
  }

  @Post('is')
  is(@Req() req: any) {
    return { is: req.is('json'), isHtml: req.is('html') };
  }

  @Get('range')
  range(@Req() req: any) {
    return { range: req.range(1000) };
  }

  @Get('format')
  format(@Req() req: any, @Res() res: any) {
    res.format({
      'application/json': () => res.json({ kind: 'json' }),
      'text/html': () => res.type('text/html').send('<b>html</b>'),
      default: () => res.status(406).send('no'),
    });
  }

  @Get('jsonp')
  jsonp(@Res() res: any) {
    res.jsonp({ ok: 1 });
  }

  @Get('helpers')
  helpers(@Res() res: any) {
    res.attachment('export.csv');
    res.location('/next');
    res.vary('Origin');
    res.vary('Accept-Encoding');
    res.append('x-multi', 'a');
    res.append('x-multi', 'b');
    res.send('ok');
  }
}

@Module({ controllers: [NegController] })
class NegModule {}

let app: any;
let baseUrl: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [NegModule] }).compile();
  app = moduleRef.createNestApplication(new BunHttpAdapter(), { logger: false });
  await app.init();
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;
});

afterAll(async () => app.close());

describe('platform-bun :: content negotiation', () => {
  it('req.accepts / acceptsEncodings / acceptsLanguages', async () => {
    const res = await fetch(`${baseUrl}/accepts`, {
      headers: {
        accept: 'text/html;q=0.9, application/json;q=0.2',
        'accept-encoding': 'br;q=1.0, gzip;q=0.5',
        'accept-language': 'fr-CH, fr;q=0.9, en;q=0.4',
      },
    });
    const body = await res.json();
    expect(body.type).toBe('html');
    expect(body.enc).toBe('br');
    expect(body.lang).toBe('fr');
  });

  it('rejects an explicitly q=0 type even under */*', async () => {
    const res = await fetch(`${baseUrl}/accepts`, {
      headers: { accept: '*/*, text/html;q=0' },
    });
    expect((await res.json()).type).toBe('json');
  });

  it('req.is matches the Content-Type', async () => {
    const res = await fetch(`${baseUrl}/is`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const body = await res.json();
    expect(body.is).toBe('json');
    expect(body.isHtml).toBe(false);
  });

  it('req.range parses a satisfiable range', async () => {
    const res = await fetch(`${baseUrl}/range`, { headers: { range: 'bytes=0-99' } });
    const body = await res.json();
    expect(body.range).toEqual([{ start: 0, end: 99 }]);
  });
});

describe('platform-bun :: response helpers', () => {
  it('res.format dispatches on Accept and sets Vary', async () => {
    const j = await fetch(`${baseUrl}/format`, {
      headers: { accept: 'application/json' },
    });
    expect(j.headers.get('vary')).toContain('Accept');
    expect(await j.json()).toEqual({ kind: 'json' });

    const h = await fetch(`${baseUrl}/format`, { headers: { accept: 'text/html' } });
    expect(await h.text()).toBe('<b>html</b>');

    const none = await fetch(`${baseUrl}/format`, {
      headers: { accept: 'application/xml' },
    });
    expect(none.status).toBe(406);
  });

  it('res.jsonp wraps in the callback when ?callback= is present', async () => {
    const res = await fetch(`${baseUrl}/jsonp?callback=cb`);
    expect(res.headers.get('content-type')).toContain('application/javascript');
    const text = await res.text();
    expect(text).toContain('cb(');
    expect(text).toContain('"ok":1');
  });

  it('res.attachment / location / vary / append', async () => {
    const res = await fetch(`${baseUrl}/helpers`);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="export.csv"',
    );
    expect(res.headers.get('location')).toBe('/next');
    expect(res.headers.get('vary')).toBe('Origin, Accept-Encoding');
    expect(res.headers.get('x-multi')).toBe('a, b');
  });
});
