import { afterEach, describe, expect, it } from 'bun:test';
import { type Socket, connect } from 'net';
import { Readable } from 'stream';
import { Controller, Get, Module, Res, Sse } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Observable } from 'rxjs';
import { BunHttpAdapter } from '../../src';
import type { BunResponse } from '../../src';
import { nodeReadableToWeb } from '../../src/http/streaming';

// The writable shim (`res.write`) used to enqueue every chunk into an
// unbounded stream and return `true`, so a producer writing to a slow client
// piled the whole body up in memory. It now reports pressure the Node way:
// `write()` returns `false` once the stream's byte budget is used up, and
// `'drain'` fires when Bun has pulled the backlog down to the socket.

const CHUNK = 'x'.repeat(16 * 1024);
const TOTAL = 8 * 1024 * 1024;

const probe = {
  written: 0,
  sawFalse: false,
  drains: 0,
  closed: false,
  afterClose: null as null | {
    writeReturned: boolean;
    writeError: unknown;
    finished: boolean;
    destroyed: boolean;
  },
};

@Controller()
class FirehoseController {
  @Get('firehose')
  firehose(@Res() res: BunResponse & Record<string, any>) {
    res.setHeader('content-type', 'application/octet-stream');
    const pump = () => {
      while (probe.written < TOTAL) {
        probe.written += CHUNK.length;
        if (!res.write(CHUNK)) {
          probe.sawFalse = true;
          res.once('drain', () => {
            probe.drains++;
            pump();
          });
          return;
        }
      }
      res.end();
    };
    pump();
  }

  @Get('forever')
  forever(@Res() res: BunResponse & Record<string, any>) {
    res.once('close', () => {
      probe.closed = true;
      // What a producer that ignores `destroyed` does next — Nest's SSE calls
      // `end()` on 'close'. Neither may reopen or "finish" the response.
      let finished = false;
      res.once('finish', () => {
        finished = true;
      });
      const result = {
        writeReturned: true,
        writeError: undefined as unknown,
        finished: false,
        destroyed: res.destroyed,
      };
      result.writeReturned = res.write('late', (err?: unknown) => {
        result.writeError = err;
      });
      res.end();
      setTimeout(() => {
        result.finished = finished;
        probe.afterClose = result;
      }, 10);
    });
    // Capped, so a shim that never reports pressure fails the test instead of
    // spinning the event loop forever.
    let budget = TOTAL;
    const pump = () => {
      while (!res.destroyed && budget > 0) {
        budget -= CHUNK.length;
        if (!res.write(CHUNK)) {
          res.once('drain', pump);
          return;
        }
      }
    };
    pump();
  }
}

@Module({ controllers: [FirehoseController] })
class AppModule {}

let app: { close(): Promise<unknown>; getHttpServer(): any } | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

async function boot(withMiddleware: boolean): Promise<number> {
  const created = await NestFactory.create(AppModule as never, new BunHttpAdapter(), {
    logger: false,
    forceCloseConnections: true,
  });
  if (withMiddleware) created.use((_q: unknown, _s: unknown, next: () => void) => next());
  await created.listen(0, '127.0.0.1');
  app = created as never;
  return created.getHttpServer().address().port;
}

/** A client that sends the request and then stops reading the socket. */
function stalledClient(port: number, path: string): Socket {
  const socket = connect(port, '127.0.0.1', () =>
    socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`),
  );
  socket.pause();
  return socket;
}

// Bun reads a response body as the socket drains only from 1.4.0; before
// that it pulls eagerly, so the queue never fills and there is no pressure
// to report — the shim still behaves, it just never says `false`.
const SOCKET_PACED = Bun.semver.satisfies(Bun.version, '>=1.4.0');

(SOCKET_PACED ? describe : describe.skip)('res.write() backpressure', () => {
  for (const [name, withMiddleware] of [
    ['native routes', false],
    ['fetch dispatcher', true],
  ] as const) {
    it(`a slow client holds the producer back, then drains — ${name}`, async () => {
      Object.assign(probe, { written: 0, sawFalse: false, drains: 0 });
      const port = await boot(withMiddleware);
      const socket = stalledClient(port, '/firehose');
      await Bun.sleep(300);

      // Bounded by the stream's byte budget plus the kernel socket buffers —
      // nowhere near the 8 MiB the handler wants to write.
      expect(probe.sawFalse).toBe(true);
      expect(probe.written).toBeLessThan(TOTAL / 2);

      let received = 0;
      const done = new Promise<void>(resolve => socket.once('close', () => resolve()));
      socket.on('data', (d: Buffer) => {
        received += d.length;
      });
      socket.resume();
      await done;

      expect(probe.written).toBe(TOTAL);
      expect(probe.drains).toBeGreaterThan(0);
      // Headers + chunked framing on top of the body.
      expect(received).toBeGreaterThan(TOTAL);
    });

    it(`a client that leaves mid-stream closes the response — ${name}`, async () => {
      probe.closed = false;
      const port = await boot(withMiddleware);
      const socket = stalledClient(port, '/forever');
      await Bun.sleep(200);
      probe.afterClose = null;
      socket.destroy();
      for (let i = 0; i < 50 && !probe.afterClose; i++) await Bun.sleep(20);
      expect(probe.closed).toBe(true);
      expect(probe.afterClose).toEqual({
        writeReturned: false,
        writeError: expect.any(Error),
        finished: false,
        destroyed: true,
      });
    });
  }
});

describe('nodeReadableToWeb fallback', () => {
  it('pauses the source until the consumer pulls, and loses nothing', async () => {
    let produced = 0;
    const size = 4 * 1024 * 1024;
    const source = new Readable({
      read() {
        produced += CHUNK.length;
        this.push(produced > size ? null : Buffer.from(CHUNK));
      },
    });
    const web = nodeReadableToWeb(source);
    await Bun.sleep(50);
    expect(produced).toBeLessThan(512 * 1024);

    let received = 0;
    for await (const chunk of web as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.byteLength;
    }
    expect(received).toBe(size);
  });
});

describe('@Sse() when the client leaves', () => {
  const sse = { unsubscribed: false, headers: {} as Record<string, unknown> };

  @Controller()
  class SseController {
    @Sse('sse')
    stream(@Res({ passthrough: true }) res: BunResponse & Record<string, any>) {
      res.setHeader('x-trace', 'abc');
      sse.headers = res.getHeaders();
      return new Observable<{ data: number }>(subscriber => {
        let i = 0;
        const timer = setInterval(() => subscriber.next({ data: i++ }), 10);
        return () => {
          clearInterval(timer);
          sse.unsubscribed = true;
        };
      });
    }
  }

  @Module({ controllers: [SseController] })
  class SseModule {}

  it('tears the subscription down and settles once', async () => {
    sse.unsubscribed = false;
    const created = await NestFactory.create(SseModule as never, new BunHttpAdapter(), {
      logger: false,
    });
    await created.listen(0, '127.0.0.1');
    app = created as never;
    const port = created.getHttpServer().address().port;

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/sse`, {
      signal: controller.signal,
    });
    expect(res.headers.get('x-trace')).toBe('abc');
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    for (let i = 0; i < 50 && !sse.unsubscribed; i++) await Bun.sleep(20);
    expect(sse.unsubscribed).toBe(true);
    expect(sse.headers['x-trace']).toBe('abc');

    // The server is still healthy afterwards.
    const again = await fetch(`http://127.0.0.1:${port}/sse`);
    const r2 = again.body!.getReader();
    expect((await r2.read()).done).toBe(false);
    await r2.cancel();
  });
});
