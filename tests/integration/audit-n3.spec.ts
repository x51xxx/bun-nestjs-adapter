import { afterEach, describe, expect, it } from 'bun:test';
import {
  Controller,
  Module,
  Post,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BunHttpAdapter } from '../../src';
import {
  BunAnyFilesInterceptor,
  BunFileInterceptor,
  BunFilesInterceptor,
  type BunUploadedFile,
} from '../../src/interceptors';

// Regression tests for N3 in the 2026-09-06 audit (see AUDIT.md).
//
// Multer's interceptors declare which file fields they accept and answer
// `LIMIT_UNEXPECTED_FILE` for anything outside that — a file under a field they
// weren't asked for, or one file too many under a field they were. The Bun
// interceptors used to ignore the extra part, so a client could upload a file
// under the wrong name, get a 201, and never learn it was dropped.
//
// Every row below was read off @nestjs/platform-express (multer 2.x) before it
// was written here:
//
//   single('f')  f            → 201       |  single('f')  f + g     → 400 - g
//   single('f')  g            → 400 - g   |  single('f')  f + f     → 400 - f
//   single('f')  no files     → 201       |  single('f')  f + text g → 201
//   array('f',3) f + f        → 201       |  array('f',3) f + g     → 400 - g
//   any()        f + g + h    → 201

let app: { close(): Promise<unknown>; getHttpServer(): any } | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

async function boot(): Promise<string> {
  const created = await NestFactory.create(UploadModule, new BunHttpAdapter(), {
    logger: false,
  });
  await created.listen(0, '127.0.0.1');
  app = created as never;
  return `http://127.0.0.1:${created.getHttpServer().address().port}`;
}

@Controller('u')
class UploadController {
  @Post('single')
  @UseInterceptors(BunFileInterceptor('f'))
  single(@UploadedFile() f?: BunUploadedFile) {
    return { f: f?.originalname ?? null };
  }

  @Post('array')
  @UseInterceptors(BunFilesInterceptor('f', 3))
  array(@UploadedFiles() fs?: BunUploadedFile[]) {
    return { n: fs?.length ?? 0 };
  }

  @Post('any')
  @UseInterceptors(BunAnyFilesInterceptor())
  any(@UploadedFiles() fs?: BunUploadedFile[]) {
    return { n: fs?.length ?? 0 };
  }
}

@Module({ controllers: [UploadController] })
class UploadModule {}

/** `['f', 'file']` adds a file part; `['f', 'text', 'field']` a text part. */
type Part = [field: string, content: string, kind?: 'field'];

const send = async (path: string, parts: Part[]) => {
  const base = await boot();
  const fd = new FormData();
  for (const [field, content, kind] of parts) {
    if (kind === 'field') fd.append(field, content);
    else fd.append(field, new File([content], `${field}.txt`, { type: 'text/plain' }));
  }
  const res = await fetch(`${base}${path}`, { method: 'POST', body: fd });
  return { status: res.status, json: await res.json() };
};

const unexpected = (field: string) => ({
  statusCode: 400,
  error: 'Bad Request',
  message: `Unexpected field - ${field}`,
});

describe('N3 — a file under an unexpected field is rejected', () => {
  describe('BunFileInterceptor takes one file, under one name', () => {
    it('accepts the field it was asked for', async () => {
      const r = await send('/u/single', [['f', 'x']]);
      expect(r.status).toBe(201);
      expect(r.json).toEqual({ f: 'f.txt' });
    });

    it('rejects a file alongside it under another name', async () => {
      const r = await send('/u/single', [
        ['f', 'x'],
        ['g', 'y'],
      ]);
      expect(r.status).toBe(400);
      expect(r.json).toMatchObject(unexpected('g'));
    });

    it('rejects a file under only the wrong name', async () => {
      const r = await send('/u/single', [['g', 'y']]);
      expect(r.status).toBe(400);
      expect(r.json).toMatchObject(unexpected('g'));
    });

    it('rejects a second file under the right name', async () => {
      const r = await send('/u/single', [
        ['f', 'x'],
        ['f', 'y'],
      ]);
      expect(r.status).toBe(400);
      expect(r.json).toMatchObject(unexpected('f'));
    });

    it('names the first offending part when several are wrong', async () => {
      const r = await send('/u/single', [
        ['f', 'x'],
        ['g', 'y'],
        ['h', 'z'],
      ]);
      expect(r.json).toMatchObject(unexpected('g'));
    });

    it('does not police text fields by name', async () => {
      const r = await send('/u/single', [
        ['f', 'x'],
        ['g', 'plain text', 'field'],
      ]);
      expect(r.status).toBe(201);
      expect(r.json).toEqual({ f: 'f.txt' });
    });

    it('still allows a request with no file at all', async () => {
      const r = await send('/u/single', [['note', 'hi', 'field']]);
      expect(r.status).toBe(201);
      expect(r.json).toEqual({ f: null });
    });
  });

  describe('BunFilesInterceptor takes many files, under one name', () => {
    it('accepts repeats of its own field', async () => {
      const r = await send('/u/array', [
        ['f', 'x'],
        ['f', 'y'],
      ]);
      expect(r.status).toBe(201);
      expect(r.json).toEqual({ n: 2 });
    });

    it('rejects a file under another name', async () => {
      const r = await send('/u/array', [
        ['f', 'x'],
        ['g', 'y'],
      ]);
      expect(r.status).toBe(400);
      expect(r.json).toMatchObject(unexpected('g'));
    });
  });

  describe('BunAnyFilesInterceptor takes everything', () => {
    it('accepts files across unrelated fields', async () => {
      const r = await send('/u/any', [
        ['f', 'x'],
        ['g', 'y'],
        ['h', 'z'],
      ]);
      expect(r.status).toBe(201);
      expect(r.json).toEqual({ n: 3 });
    });
  });
});
