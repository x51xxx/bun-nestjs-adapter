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
  BunFileInterceptor,
  BunFilesInterceptor,
  type BunUploadedFile,
} from '../../src/interceptors';

// Regression tests for M6 in the 2026-09-06 audit (see AUDIT.md).
//
// `Request.formData()` materialises every part before it returns, so `fileSize`
// and `files` can only ever be *checked* after the bytes are in memory — a 2 GB
// upload against `fileSize: 1_000_000` was buffered in full and only then
// rejected. `totalSize` closes that: it is compared against `Content-Length`
// before the body is read. Also here: `maxCount` now rejects instead of
// silently dropping the extra file, `formData()` is memoised so two
// interceptors on one route work, and the exceptions carry Multer's own
// wording (measured against @nestjs/platform-express).

let app: { close(): Promise<unknown>; getHttpServer(): any } | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

async function boot(moduleClass: unknown): Promise<string> {
  const created = await NestFactory.create(moduleClass as never, new BunHttpAdapter(), {
    logger: false,
  });
  await created.listen(0, '127.0.0.1');
  app = created as never;
  return `http://127.0.0.1:${created.getHttpServer().address().port}`;
}

const form = (parts: Array<[string, string]>) => {
  const fd = new FormData();
  for (const [field, content] of parts) {
    fd.append(field, new File([content], `${field}.txt`, { type: 'text/plain' }));
  }
  return fd;
};

const post = (url: string, body: BodyInit) => fetch(url, { method: 'POST', body });

@Controller('u')
class UploadController {
  // Derived pre-check: fileSize * 1 + 1 MiB.
  @Post('derived')
  @UseInterceptors(BunFileInterceptor('f', { limits: { fileSize: 8 } }))
  derived(@UploadedFile() f?: BunUploadedFile) {
    return { size: f?.size ?? null };
  }

  // Explicit, tiny whole-request ceiling.
  @Post('total')
  @UseInterceptors(BunFileInterceptor('f', { limits: { totalSize: 10 } }))
  total(@UploadedFile() f?: BunUploadedFile) {
    return { size: f?.size ?? null };
  }

  // Explicitly opted out of the pre-check, so only the post-buffer rule runs.
  @Post('no-precheck')
  @UseInterceptors(
    BunFileInterceptor('f', {
      limits: { fileSize: 8, totalSize: Number.POSITIVE_INFINITY },
    }),
  )
  noPrecheck(@UploadedFile() f?: BunUploadedFile) {
    return { size: f?.size ?? null };
  }

  @Post('count')
  @UseInterceptors(BunFilesInterceptor('f', undefined, { limits: { files: 2 } }))
  count(@UploadedFiles() fs?: BunUploadedFile[]) {
    return { n: fs?.length ?? 0 };
  }

  // Two interceptors on one route: the second used to hit `Body already used`.
  @Post('two')
  @UseInterceptors(BunFileInterceptor('f'), BunFilesInterceptor('g'))
  two(@UploadedFile() f?: BunUploadedFile, @UploadedFiles() gs?: BunUploadedFile[]) {
    return { f: f?.originalname ?? null, g: gs?.map(x => x.originalname) ?? [] };
  }
}

@Module({ controllers: [UploadController] })
class UploadModule {}

describe('M6 — upload limits', () => {
  describe('the pre-check runs before the body is read', () => {
    // A body that is not parseable multipart at all. If the size guard ran
    // after `formData()`, this would fail on the parse instead of on the size —
    // which is exactly the ordering the fix is about.
    const UNPARSEABLE: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=nope' },
      body: 'x'.repeat(200),
    };

    it('rejects on Content-Length alone, before parsing', async () => {
      const base = await boot(UploadModule);
      const res = await fetch(`${base}/u/total`, UNPARSEABLE);
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({
        statusCode: 413,
        message: 'File too large',
      });
    });

    it('does not answer 413 for the same body when the size is allowed', async () => {
      const base = await boot(UploadModule);
      const res = await fetch(`${base}/u/no-precheck`, UNPARSEABLE);
      // Whatever the unparseable body produces, it is not the size rejection.
      expect(res.status).not.toBe(413);
    });
  });

  describe('the ceiling derived from fileSize', () => {
    it('lets a normal upload through', async () => {
      const base = await boot(UploadModule);
      const res = await post(`${base}/u/derived`, form([['f', 'abcdefgh']]));
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ size: 8 });
    });

    it('still enforces fileSize after the part is in memory', async () => {
      const base = await boot(UploadModule);
      // Comfortably under the derived ceiling (8 + 1 MiB), so it reaches the
      // post-buffer rule — which is the one that can compare a single part.
      const res = await post(`${base}/u/derived`, form([['f', 'x'.repeat(64)]]));
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ message: 'File too large' });
    });

    it('is skipped entirely when totalSize is Infinity', async () => {
      const base = await boot(UploadModule);
      const res = await post(`${base}/u/no-precheck`, form([['f', 'abcdefgh']]));
      expect(res.status).toBe(201);
    });

    it('has nothing to check on a chunked upload', async () => {
      const base = await boot(UploadModule);
      const boundary = 'bun-test-boundary';
      const body = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="f"; filename="f.txt"',
        'Content-Type: text/plain',
        '',
        'abcdefgh',
        `--${boundary}--`,
        '',
      ].join('\r\n');
      const res = await fetch(`${base}/u/derived`, {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        // A stream body means no Content-Length, so the pre-check has nothing
        // to compare and the post-buffer rules take over.
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(body));
            c.close();
          },
        }),
        // @ts-expect-error — `duplex` is required for a stream body
        duplex: 'half',
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ size: 8 });
    });
  });

  describe('counts and messages match Multer', () => {
    it('answers 400 "Too many files" past limits.files', async () => {
      const base = await boot(UploadModule);
      const res = await post(
        `${base}/u/count`,
        form([
          ['f', 'a'],
          ['f', 'b'],
          ['f', 'c'],
        ]),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        statusCode: 400,
        message: 'Too many files',
      });
    });

    it('allows exactly limits.files', async () => {
      const base = await boot(UploadModule);
      const res = await post(
        `${base}/u/count`,
        form([
          ['f', 'a'],
          ['f', 'b'],
        ]),
      );
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ n: 2 });
    });
  });

  it('runs two interceptors on one route off a single parse', async () => {
    const base = await boot(UploadModule);
    const res = await post(
      `${base}/u/two`,
      form([
        ['f', 'one'],
        ['g', 'two'],
      ]),
    );
    // Previously: the second interceptor hit `Body already used`, because a Web
    // Request body can only be read once.
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ f: 'f.txt', g: ['g.txt'] });
  });
});
