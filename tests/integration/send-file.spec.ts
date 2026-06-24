/**
 * res.sendFile() / res.download() — backed by Bun.file with the shared
 * range/etag/conditional logic from static serving.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { join } from 'path';
import { Controller, Get, Module, Res } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BunHttpAdapter } from '../../src';

const ROOT = join(__dirname, 'fixtures', 'own', 'static');
const DATA = join(ROOT, 'data.json');

@Controller()
class FileController {
  @Get('abs')
  abs(@Res() res: any) {
    res.sendFile(DATA);
  }

  @Get('rooted')
  rooted(@Res() res: any) {
    res.sendFile('data.json', { root: ROOT, cacheControl: 'public, max-age=60' });
  }

  @Get('missing')
  missing(@Res() res: any) {
    res.sendFile(join(ROOT, 'nope.json'));
  }

  @Get('relative-no-root')
  relativeNoRoot(@Res() res: any) {
    res.sendFile('data.json', undefined, (err: unknown) => {
      res.status(400).json({ error: err ? String((err as Error).message) : null });
    });
  }

  @Get('traversal')
  traversal(@Res() res: any) {
    res.sendFile('../../secret', { root: ROOT });
  }

  @Get('dl')
  dl(@Res() res: any) {
    res.download(DATA);
  }

  @Get('dl-named')
  dlNamed(@Res() res: any) {
    res.download(DATA, 'report.json');
  }
}

@Module({ controllers: [FileController] })
class FileModule {}

let app: any;
let baseUrl: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [FileModule] }).compile();
  app = moduleRef.createNestApplication(new BunHttpAdapter(), { logger: false });
  await app.init();
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;
});

afterAll(async () => app.close());

describe('platform-bun :: res.sendFile / res.download', () => {
  it('serves an absolute path with type, etag and content-length', async () => {
    const res = await fetch(`${baseUrl}/abs`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('content-length')).toBe('31');
    expect(res.headers.get('etag')).toBeTruthy();
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(await res.json()).toEqual({ static: true, server: 'bun' });
  });

  it('resolves a relative path against options.root + cacheControl', async () => {
    const res = await fetch(`${baseUrl}/rooted`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('honours a byte range via sendFile', async () => {
    const res = await fetch(`${baseUrl}/abs`, { headers: { range: 'bytes=0-8' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-8/31');
    expect(await res.text()).toBe('{"static"');
  });

  it('404s on a missing file', async () => {
    const res = await fetch(`${baseUrl}/missing`);
    expect(res.status).toBe(404);
  });

  it('invokes the callback with an error for a relative path without root', async () => {
    const res = await fetch(`${baseUrl}/relative-no-root`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('absolute');
  });

  it('rejects path traversal under root with 403', async () => {
    const res = await fetch(`${baseUrl}/traversal`);
    expect(res.status).toBe(403);
  });

  it('sets Content-Disposition: attachment with the basename', async () => {
    const res = await fetch(`${baseUrl}/dl`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="data.json"',
    );
  });

  it('uses an explicit download filename', async () => {
    const res = await fetch(`${baseUrl}/dl-named`);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="report.json"',
    );
  });
});
