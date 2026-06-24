/**
 * Additional Express helpers: res.sendStatus / res.links and
 * req.xhr / req.subdomains / req.fresh / req.stale.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Controller, Get, Module, Req, Res } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BunHttpAdapter } from '../../src';

@Controller()
class HelperController {
  @Get('status')
  status(@Res() res: any) {
    res.sendStatus(418);
  }

  @Get('links')
  links(@Res() res: any) {
    res.links({ next: '/page/2', last: '/page/9' }).send('ok');
  }

  @Get('xhr')
  xhr(@Req() req: any) {
    return { xhr: req.xhr };
  }

  @Get('subs')
  subs(@Req() req: any) {
    return { subdomains: req.subdomains, hostname: req.hostname };
  }

  @Get('fresh')
  fresh(@Req() req: any, @Res() res: any) {
    res.set('ETag', 'W/"abc"');
    res.json({ fresh: req.fresh, stale: req.stale });
  }
}

@Module({ controllers: [HelperController] })
class HelperModule {}

let app: any;
let baseUrl: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [HelperModule] }).compile();
  app = moduleRef.createNestApplication(new BunHttpAdapter(), { logger: false });
  await app.init();
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;
});

afterAll(async () => app.close());

describe('platform-bun :: extra Express helpers', () => {
  it('res.sendStatus sends the status code and reason phrase', async () => {
    const res = await fetch(`${baseUrl}/status`);
    expect(res.status).toBe(418);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe("I'm a Teapot");
  });

  it('res.links sets the Link header', async () => {
    const res = await fetch(`${baseUrl}/links`);
    expect(res.headers.get('link')).toBe('</page/2>; rel="next", </page/9>; rel="last"');
    expect(await res.text()).toBe('ok');
  });

  it('req.xhr reflects X-Requested-With', async () => {
    const yes = await fetch(`${baseUrl}/xhr`, {
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    });
    expect((await yes.json()).xhr).toBe(true);
    const no = await fetch(`${baseUrl}/xhr`);
    expect((await no.json()).xhr).toBe(false);
  });

  it('req.subdomains derives from the Host header', async () => {
    const res = await fetch(`${baseUrl}/subs`, {
      headers: { host: 'api.admin.example.com' },
    });
    const body = await res.json();
    expect(body.hostname).toBe('api.admin.example.com');
    expect(body.subdomains).toEqual(['admin', 'api']);
  });

  it('req.fresh is true when If-None-Match matches the response ETag', async () => {
    const res = await fetch(`${baseUrl}/fresh`, {
      headers: { 'if-none-match': 'W/"abc"' },
    });
    const body = await res.json();
    expect(body.fresh).toBe(true);
    expect(body.stale).toBe(false);
  });

  it('req.fresh is false without a matching validator', async () => {
    const res = await fetch(`${baseUrl}/fresh`);
    const body = await res.json();
    expect(body.fresh).toBe(false);
    expect(body.stale).toBe(true);
  });
});
