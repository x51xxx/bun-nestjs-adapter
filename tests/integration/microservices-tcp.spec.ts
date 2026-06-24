import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ClientTCP, ServerTCP } from '@nestjs/microservices';
import type { TCPSocketListener } from 'bun';
import { firstValueFrom, throwError } from 'rxjs';
import { BunClientTcp, BunServerTcp } from '../../src/microservices';

const HOST = '127.0.0.1';

/** Promisified strategy.listen() for both Bun and stock Nest servers. */
function listen(server: { listen: (cb: (err?: unknown) => void) => void }) {
  return new Promise<void>((resolve, reject) => {
    server.listen(err => (err ? reject(err) : resolve()));
  });
}

// Shared sink so event-pattern handlers can be asserted from the test body.
const eventSink: unknown[] = [];

function registerHandlers(server: BunServerTcp | ServerTCP) {
  server.addHandler('sum', (data: number[]) => data.reduce((a, b) => a + b, 0), false);
  server.addHandler('greet', async (name: string) => `hi ${name}`, false);
  server.addHandler(
    { cmd: 'multiply' },
    (data: number[]) => data.reduce((a, b) => a * b, 1),
    false,
  );
  server.addHandler('unicode', (s: string) => `${s}${s}`, false);
  server.addHandler('fail', () => throwError(() => new Error('handler failed')), false);
  server.addHandler('user.created', (data: unknown) => eventSink.push(data), true);
}

describe('platform-bun :: microservices TCP (Bun server + Bun client)', () => {
  let server: BunServerTcp;
  let client: BunClientTcp;

  beforeAll(async () => {
    server = new BunServerTcp({ host: HOST, port: 0 });
    registerHandlers(server);
    await listen(server);
    const port = server.unwrap<TCPSocketListener>().port;
    client = new BunClientTcp({ host: HOST, port });
    await client.connect();
  });

  afterAll(async () => {
    client.close();
    server.close();
  });

  it('resolves a request/response message pattern', async () => {
    expect(await firstValueFrom(client.send('sum', [1, 2, 3, 4]))).toBe(10);
  });

  it('awaits an async handler', async () => {
    expect(await firstValueFrom(client.send('greet', 'ada'))).toBe('hi ada');
  });

  it('matches an object (cmd) pattern', async () => {
    expect(await firstValueFrom(client.send({ cmd: 'multiply' }, [2, 3, 4]))).toBe(24);
  });

  it('frames multibyte UTF-8 payloads losslessly', async () => {
    const payload = 'наді🚀—中文';
    expect(await firstValueFrom(client.send('unicode', payload))).toBe(payload + payload);
  });

  it('propagates a handler error to the caller', async () => {
    await expect(firstValueFrom(client.send('fail', {}))).rejects.toBeDefined();
  });

  it('rejects when no handler matches the pattern', async () => {
    await expect(firstValueFrom(client.send('does-not-exist', {}))).rejects.toContain(
      'no matching message handler',
    );
  });

  it('delivers a fire-and-forget event pattern', async () => {
    eventSink.length = 0;
    client.emit('user.created', { id: 7 });
    await Bun.sleep(120);
    expect(eventSink).toEqual([{ id: 7 }]);
  });

  it('handles many concurrent requests without frame interleaving', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => firstValueFrom(client.send('sum', [i, 1]))),
    );
    expect(results).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
});

describe('platform-bun :: microservices TCP wire compatibility', () => {
  it('Bun client interoperates with a stock Nest ServerTCP', async () => {
    const server = new ServerTCP({ host: HOST, port: 0 });
    registerHandlers(server);
    await listen(server);
    const port = (
      server.unwrap<{ address(): { port: number } }>().address() as {
        port: number;
      }
    ).port;
    const client = new BunClientTcp({ host: HOST, port });
    await client.connect();
    try {
      expect(await firstValueFrom(client.send('sum', [10, 20]))).toBe(30);
      expect(await firstValueFrom(client.send('greet', 'bun'))).toBe('hi bun');
    } finally {
      client.close();
      server.close();
    }
  });

  it('stock Nest ClientTCP interoperates with BunServerTcp', async () => {
    const server = new BunServerTcp({ host: HOST, port: 0 });
    registerHandlers(server);
    await listen(server);
    const port = server.unwrap<TCPSocketListener>().port;
    const client = new ClientTCP({ host: HOST, port });
    await client.connect();
    try {
      expect(await firstValueFrom(client.send('sum', [4, 5, 6]))).toBe(15);
      expect(await firstValueFrom(client.send({ cmd: 'multiply' }, [2, 5]))).toBe(10);
    } finally {
      client.close();
      server.close();
    }
  });
});
