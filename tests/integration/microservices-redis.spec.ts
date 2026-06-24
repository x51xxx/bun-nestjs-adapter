/**
 * Bun Redis microservices transport (Bun.RedisClient Pub/Sub).
 *
 * Requires a Redis server on REDIS_URL (or localhost:6379). When none is
 * reachable every case no-ops so CI without Redis stays green.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { firstValueFrom, throwError } from 'rxjs';
import { BunClientRedis, BunServerRedis } from '../../src/microservices';

const URL = process.env.REDIS_URL || 'redis://localhost:6379';

const eventSink: unknown[] = [];

describe('platform-bun :: microservices Redis (Bun server + Bun client)', () => {
  let server: BunServerRedis | undefined;
  let client: BunClientRedis | undefined;
  let ready = false;

  beforeAll(async () => {
    try {
      server = new BunServerRedis({ url: URL });
      server.addHandler(
        'r.sum',
        (data: number[]) => data.reduce((a, b) => a + b, 0),
        false,
      );
      server.addHandler('r.greet', async (name: string) => `hi ${name}`, false);
      server.addHandler(
        { cmd: 'r.multiply' },
        (data: number[]) => data.reduce((a, b) => a * b, 1),
        false,
      );
      server.addHandler('r.fail', () => throwError(() => new Error('boom')), false);
      server.addHandler('r.event', (data: unknown) => eventSink.push(data), true);
      await new Promise<void>((res, rej) =>
        server!.listen(err => (err ? rej(err) : res())),
      );
      client = new BunClientRedis({ url: URL });
      await client.connect();
      ready = true;
    } catch {
      ready = false; // no Redis reachable — cases below no-op
    }
  });

  afterAll(async () => {
    await client?.close();
    await server?.close();
  });

  it('resolves a request/response message pattern', async () => {
    if (!ready) return;
    expect(await firstValueFrom(client!.send('r.sum', [1, 2, 3, 4]))).toBe(10);
  });

  it('awaits an async handler', async () => {
    if (!ready) return;
    expect(await firstValueFrom(client!.send('r.greet', 'ada'))).toBe('hi ada');
  });

  it('matches an object (cmd) pattern', async () => {
    if (!ready) return;
    expect(await firstValueFrom(client!.send({ cmd: 'r.multiply' }, [2, 3, 4]))).toBe(24);
  });

  it('propagates a handler error to the caller', async () => {
    if (!ready) return;
    await expect(firstValueFrom(client!.send('r.fail', {}))).rejects.toBeDefined();
  });

  it('delivers a fire-and-forget event pattern', async () => {
    if (!ready) return;
    eventSink.length = 0;
    client!.emit('r.event', { id: 42 });
    await Bun.sleep(150);
    expect(eventSink).toEqual([{ id: 42 }]);
  });

  it('handles concurrent requests by id', async () => {
    if (!ready) return;
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => firstValueFrom(client!.send('r.sum', [i, 1]))),
    );
    expect(results).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });
});
