import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import { BunHttpAdapter } from '../../src';
import { StreamingModule } from './fixtures/own/streaming/streaming.module';

describe('platform-bun :: StreamableFile + Node Readable', () => {
  let app: any;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StreamingModule],
    }).compile();
    app = moduleRef.createNestApplication(new BunHttpAdapter(), {
      logger: false,
    });
    await app.init();
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => app.close());

  it('streams a Uint8Array-backed StreamableFile with type header', async () => {
    const res = await fetch(`${baseUrl}/streaming/streamable-buffer`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(await res.text()).toBe('hello-from-streamable-file');
  });

  it('streams a Node Readable inside StreamableFile', async () => {
    const res = await fetch(`${baseUrl}/streaming/streamable-readable`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('chunk-0;chunk-1;chunk-2;');
  });

  it('streams a bare Node Readable returned from a controller', async () => {
    const res = await fetch(`${baseUrl}/streaming/readable-direct`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(await res.text()).toBe('01234');
  });
});

describe('platform-bun :: Server-Sent Events (@Sse)', () => {
  let app: any;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StreamingModule],
    }).compile();
    app = moduleRef.createNestApplication(new BunHttpAdapter(), {
      logger: false,
    });
    await app.init();
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => app.close());

  it('emits text/event-stream with SSE-formatted messages', async () => {
    const res = await fetch(`${baseUrl}/streaming/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    // Expect three SSE messages with tick=0,1,2
    expect(body).toContain('data: {"tick":0}');
    expect(body).toContain('data: {"tick":1}');
    expect(body).toContain('data: {"tick":2}');
  });

  it('streams events incrementally (not buffered until completion)', async () => {
    const res = await fetch(`${baseUrl}/streaming/events`);
    expect(res.body).not.toBeNull();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let firstChunkAt = 0;
    let lastChunkAt = 0;
    const start = performance.now();
    const seenTicks: number[] = [];
    while (true) {
      const { value, done } = await reader.read();
      const now = performance.now();
      if (firstChunkAt === 0 && value && value.byteLength > 0) {
        firstChunkAt = now;
      }
      if (value && value.byteLength > 0) {
        lastChunkAt = now;
        const text = decoder.decode(value);
        const matches = text.matchAll(/"tick":(\d+)/g);
        for (const m of matches) seenTicks.push(Number(m[1]));
      }
      if (done) break;
    }
    expect(seenTicks).toEqual([0, 1, 2]);
    // Last chunk must arrive at least ~50ms after the first — proves streaming.
    expect(lastChunkAt - firstChunkAt).toBeGreaterThan(40);
    // First chunk should arrive well before the controller completes (3 × 50ms).
    expect(firstChunkAt - start).toBeLessThan(120);
  });
});
