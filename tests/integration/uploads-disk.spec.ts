/**
 * Disk-storage multipart uploads — files streamed to a temp dir via Bun.write
 * instead of buffering in memory (BunFileInterceptor `{ dest }`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Controller, Module, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BunFileInterceptor, BunHttpAdapter } from '../../src';

const DEST = join(tmpdir(), `bun-upload-${randomUUID()}`);

@Controller('uploads')
class DiskUploadsController {
  @Post('disk')
  @UseInterceptors(BunFileInterceptor('avatar', { dest: DEST }))
  upload(@UploadedFile() file: any) {
    return { file };
  }
}

@Module({ controllers: [DiskUploadsController] })
class DiskUploadsModule {}

let app: any;
let baseUrl: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [DiskUploadsModule],
  }).compile();
  app = moduleRef.createNestApplication(new BunHttpAdapter(), { logger: false });
  await app.init();
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;
});

afterAll(async () => {
  await app.close();
  await fs.rm(DEST, { recursive: true, force: true });
});

describe('platform-bun :: disk-storage uploads', () => {
  it('writes the upload to disk and returns path metadata (no buffer)', async () => {
    const fd = new FormData();
    fd.append('avatar', new File(['disk-bytes-123'], 'pic.png', { type: 'image/png' }));

    const res = await fetch(`${baseUrl}/uploads/disk`, { method: 'POST', body: fd });
    expect(res.status).toBe(201);
    const { file } = await res.json();

    expect(file.originalname).toBe('pic.png');
    expect(file.mimetype).toBe('image/png');
    expect(file.size).toBe(14);
    expect(file.destination).toBe(DEST);
    expect(file.filename).toMatch(/\.png$/);
    expect(file.path).toBe(join(DEST, file.filename));
    expect(file.buffer).toBeUndefined();

    // The bytes really landed on disk.
    expect(await Bun.file(file.path).text()).toBe('disk-bytes-123');
  });
});
