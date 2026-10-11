import { afterEach, describe, expect, it } from 'bun:test';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { BunHttpAdapter, BunWsAdapter, type BunWsClient } from '../../src';

// Bun's WebSocket tuning (`maxPayloadLength`, `perMessageDeflate`, …) is
// server-wide: a shared-port gateway takes it from `new BunHttpAdapter({
// websocket })`, a gateway on its own port from `new BunWsAdapter(app, {
// websocket })`. `maxPayloadLength` is the observable one: Bun drops a socket
// that sends a bigger message (the client sees 1006 — Bun closes the TCP
// connection rather than sending a 1009 frame), and without the limit the
// same message is answered.

const STANDALONE_PORT = 40_000 + Math.floor(Math.random() * 10_000);

@WebSocketGateway({ path: '/ws' })
class SharedGateway {
  @SubscribeMessage('echo')
  echo(@MessageBody() data: unknown, @ConnectedSocket() client: BunWsClient) {
    // Status of a direct send: bytes written on success.
    const status = client.send(JSON.stringify({ event: 'raw', data }));
    return { event: 'echo', data: { status } };
  }
}

@WebSocketGateway(STANDALONE_PORT, { path: '/ws' })
class StandaloneGateway {
  @SubscribeMessage('echo')
  echo(@MessageBody() data: unknown) {
    return { event: 'echo', data };
  }
}

@Module({ providers: [SharedGateway] })
class SharedModule {}

@Module({ providers: [StandaloneGateway] })
class StandaloneModule {}

let app: { close(): Promise<unknown>; getHttpServer(): any } | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

function open(url: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', reject as never, { once: true });
  });
}

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise(resolve =>
    ws.addEventListener('close', ev => resolve((ev as CloseEvent).code), { once: true }),
  );
}

function messages(ws: WebSocket, count: number): Promise<any[]> {
  const out: any[] = [];
  return new Promise(resolve => {
    const onMessage = (ev: MessageEvent) => {
      out.push(JSON.parse(ev.data as string));
      if (out.length === count) {
        ws.removeEventListener('message', onMessage);
        resolve(out);
      }
    };
    ws.addEventListener('message', onMessage);
  });
}

async function bootShared(adapter: BunHttpAdapter): Promise<number> {
  const created = await NestFactory.create(SharedModule as never, adapter, {
    logger: false,
  });
  created.useWebSocketAdapter(new BunWsAdapter(created));
  await created.listen(0, '127.0.0.1');
  app = created as never;
  return created.getHttpServer().address().port;
}

const BIG = JSON.stringify({ event: 'echo', data: 'x'.repeat(1024) });

describe('WebSocket options', () => {
  it('shared port: BunHttpAdapter({ websocket }) reaches Bun.serve', async () => {
    const port = await bootShared(
      new BunHttpAdapter({ websocket: { maxPayloadLength: 256 } }),
    );
    const ws = await open(`ws://127.0.0.1:${port}/ws`);
    const replies = messages(ws, 2);
    ws.send(JSON.stringify({ event: 'echo', data: 'hi' }));
    const [raw, echo] = await replies;
    expect(raw).toEqual({ event: 'raw', data: 'hi' });
    expect(echo.event).toBe('echo');
    // `client.send()` now reports Bun's status: bytes written.
    expect(echo.data.status).toBeGreaterThan(0);

    const closed = closeCode(ws);
    ws.send(BIG);
    expect(await closed).not.toBe(1000);
  });

  it('shared port without the option: the same message is answered', async () => {
    const port = await bootShared(new BunHttpAdapter());
    const ws = await open(`ws://127.0.0.1:${port}/ws`);
    const replies = messages(ws, 2);
    ws.send(BIG);
    const [raw] = await replies;
    expect(raw.event).toBe('raw');
    ws.close();
  });

  it('standalone port: BunWsAdapter(app, { websocket }) reaches its own Bun.serve', async () => {
    const created = await NestFactory.create(
      StandaloneModule as never,
      new BunHttpAdapter(),
      {
        logger: false,
      },
    );
    created.useWebSocketAdapter(
      new BunWsAdapter(created, { websocket: { maxPayloadLength: 256 } }),
    );
    await created.listen(0, '127.0.0.1');
    app = created as never;

    const ws = await open(`ws://127.0.0.1:${STANDALONE_PORT}/ws`);
    const reply = messages(ws, 1);
    ws.send(JSON.stringify({ event: 'echo', data: 'hi' }));
    expect(await reply).toEqual([{ event: 'echo', data: 'hi' }]);

    const closed = closeCode(ws);
    ws.send(BIG);
    expect(await closed).not.toBe(1000);
  });
});
