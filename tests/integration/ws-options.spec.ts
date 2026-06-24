/**
 * BunWsAdapter websocket tuning passthrough (maxPayloadLength), verified on a
 * standalone-port gateway. A message above the limit makes Bun close the
 * socket with 1009 (message too big) before our handler runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import { MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { BunHttpAdapter, BunWsAdapter } from '../../src';

const WS_PORT = 8793;

@WebSocketGateway(WS_PORT)
class LimitedGateway {
  @SubscribeMessage('push')
  onPush(@MessageBody() data: any) {
    return { event: 'pop', data };
  }
}

let app: any;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [LimitedGateway],
  }).compile();
  app = moduleRef.createNestApplication(new BunHttpAdapter(), { logger: false });
  app.useWebSocketAdapter(
    new BunWsAdapter(app, { websocket: { maxPayloadLength: 1024 } }),
  );
  await app.init();
  await app.listen(0, '127.0.0.1');
});

afterAll(async () => app.close());

function open(url: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', reject as any, { once: true });
  });
}

describe('platform-bun :: WS maxPayloadLength', () => {
  it('still echoes a normal-sized message', async () => {
    const ws = await open(`ws://127.0.0.1:${WS_PORT}`);
    const reply = new Promise<any>(resolve => {
      ws.addEventListener(
        'message',
        ev => resolve(JSON.parse((ev as MessageEvent).data as string)),
        { once: true },
      );
    });
    ws.send(JSON.stringify({ event: 'push', data: { hi: 1 } }));
    expect(await reply).toEqual({ event: 'pop', data: { hi: 1 } });
    ws.close();
  });

  it('closes the socket for an over-limit message', async () => {
    const ws = await open(`ws://127.0.0.1:${WS_PORT}`);
    const closed = new Promise<number>(resolve => {
      ws.addEventListener('close', ev => resolve((ev as CloseEvent).code), {
        once: true,
      });
    });
    ws.send(JSON.stringify({ event: 'push', data: { blob: 'x'.repeat(4000) } }));
    const code = await closed;
    // 1009 = message too big (clean); 1006 = abnormal (server dropped the
    // frame without a close handshake). Either proves the limit was enforced.
    expect([1006, 1009]).toContain(code);
  });
});
