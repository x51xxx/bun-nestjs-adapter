import { afterEach, describe, expect, it } from 'bun:test';
import { Controller, Module, Sse } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Observable } from 'rxjs';
import { BunHttpAdapter } from '../../src';

// Parity with the @nestjs/platform-express fixes that landed between v12.0.1
// and v12.1.2 (see the upstream commit named in each describe block).

let app: { close(): Promise<unknown>; getHttpServer(): any } | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

async function boot(
  moduleClass: unknown,
  configure?: (app: any) => void,
  options: Record<string, unknown> = {},
): Promise<string> {
  const created = await NestFactory.create(moduleClass as never, new BunHttpAdapter(), {
    logger: false,
    ...options,
  });
  configure?.(created);
  await created.listen(0, '127.0.0.1');
  app = created as never;
  return `http://127.0.0.1:${created.getHttpServer().address().port}`;
}

describe('forceCloseConnections', () => {
  let unsubscribed = false;

  @Controller()
  class SseController {
    @Sse('sse')
    sse() {
      return new Observable<{ data: number }>(subscriber => {
        let i = 0;
        const timer = setInterval(() => subscriber.next({ data: i++ }), 20);
        return () => {
          clearInterval(timer);
          unsubscribed = true;
        };
      });
    }
  }

  @Module({ controllers: [SseController] })
  class SseModule {}

  it('close() drops an open SSE connection and tears the stream down', async () => {
    unsubscribed = false;
    const base = await boot(SseModule, undefined, { forceCloseConnections: true });
    const res = await fetch(`${base}/sse`);
    const reader = res.body!.getReader();
    await reader.read();

    const closing = app!.close();
    app = null;
    const outcome = await Promise.race([
      closing.then(() => 'closed'),
      Bun.sleep(2000).then(() => 'hung'),
    ]);
    expect(outcome).toBe('closed');
    // The client side sees the stream end rather than hanging forever.
    await reader.read().catch(() => undefined);
    await Bun.sleep(20);
    expect(unsubscribed).toBe(true);
  });
});
