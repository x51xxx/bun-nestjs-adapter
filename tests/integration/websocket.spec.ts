import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import { BunHttpAdapter, BunWsAdapter } from '../../src';
import { ChatGateway } from './fixtures/own/ws/chat.gateway';
import { EchoGateway } from './fixtures/own/ws/echo.gateway';
import { PathAGateway } from './fixtures/own/ws/path-a.gateway';
import { PathBGateway } from './fixtures/own/ws/path-b.gateway';
import { SharedGateway } from './fixtures/own/ws/shared.gateway';

async function bootApp(providers: any[]) {
  const moduleRef = await Test.createTestingModule({ providers }).compile();
  const app = moduleRef.createNestApplication(new BunHttpAdapter(), {
    logger: false,
  });
  app.useWebSocketAdapter(new BunWsAdapter(app));
  await app.init();
  await app.listen(0, '127.0.0.1');
  return app;
}

function open(url: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', reject as any, { once: true });
  });
}

function nextMessage(ws: WebSocket): Promise<any> {
  return new Promise(resolve => {
    ws.addEventListener(
      'message',
      ev => resolve(JSON.parse((ev as MessageEvent).data as string)),
      { once: true },
    );
  });
}

describe('platform-bun :: WebSocket gateway (single port)', () => {
  let app: any;

  beforeAll(async () => {
    app = await bootApp([EchoGateway]);
  });
  afterAll(async () => app.close());

  it('routes "push" event back as "pop" with same payload', async () => {
    const ws = await open('ws://127.0.0.1:8765/');
    ws.send(JSON.stringify({ event: 'push', data: { test: 'hello' } }));
    const msg = await nextMessage(ws);
    expect(msg).toEqual({ event: 'pop', data: { test: 'hello' } });
    ws.close();
  });

  it('routes "reverse" with custom handler logic', async () => {
    const ws = await open('ws://127.0.0.1:8765/');
    ws.send(JSON.stringify({ event: 'reverse', data: { value: 'bun-ws' } }));
    const msg = await nextMessage(ws);
    expect(msg).toEqual({
      event: 'reverse-result',
      data: { value: 'sw-nub' },
    });
    ws.close();
  });

  it('multiple sequential messages on the same socket', async () => {
    const ws = await open('ws://127.0.0.1:8765/');
    ws.send(JSON.stringify({ event: 'push', data: { n: 1 } }));
    const m1 = await nextMessage(ws);
    expect(m1).toEqual({ event: 'pop', data: { n: 1 } });
    ws.send(JSON.stringify({ event: 'push', data: { n: 2 } }));
    const m2 = await nextMessage(ws);
    expect(m2).toEqual({ event: 'pop', data: { n: 2 } });
    ws.close();
  });

  it('ignores messages without registered handler', async () => {
    const ws = await open('ws://127.0.0.1:8765/');
    let received = false;
    ws.addEventListener('message', () => (received = true));
    ws.send(JSON.stringify({ event: 'no-such-event', data: {} }));
    await new Promise(r => setTimeout(r, 100));
    expect(received).toBe(false);
    ws.close();
  });
});

describe('platform-bun :: WebSocket gateway (multi-path on one port)', () => {
  let app: any;

  beforeAll(async () => {
    app = await bootApp([PathAGateway, PathBGateway]);
  });
  afterAll(async () => app.close());

  it('routes /path-a to its gateway', async () => {
    const ws = await open('ws://127.0.0.1:8766/path-a');
    ws.send(JSON.stringify({ event: 'ping', data: { which: 'a' } }));
    const msg = await nextMessage(ws);
    expect(msg).toEqual({ event: 'pong-a', data: { which: 'a' } });
    ws.close();
  });

  it('routes /path-b to its gateway', async () => {
    const ws = await open('ws://127.0.0.1:8766/path-b');
    ws.send(JSON.stringify({ event: 'ping', data: { which: 'b' } }));
    const msg = await nextMessage(ws);
    expect(msg).toEqual({ event: 'pong-b', data: { which: 'b' } });
    ws.close();
  });

  it('rejects connection to unknown path on the same port', async () => {
    let opened = false;
    let rejected = false;
    await new Promise<void>(resolve => {
      const ws = new WebSocket('ws://127.0.0.1:8766/unknown');
      ws.addEventListener('open', () => {
        opened = true;
        ws.close();
        resolve();
      });
      ws.addEventListener('error', () => {
        rejected = true;
        resolve();
      });
      ws.addEventListener('close', () => resolve());
    });
    expect(opened).toBe(false);
    expect(rejected).toBe(true);
  });
});

describe('platform-bun :: native Bun pub/sub via @WebSocketServer', () => {
  let app: any;

  beforeAll(async () => {
    app = await bootApp([ChatGateway]);
  });
  afterAll(async () => app.close());

  it('broadcasts to all clients subscribed to the same topic', async () => {
    const a = await open('ws://127.0.0.1:8767/chat');
    const b = await open('ws://127.0.0.1:8767/chat');
    const c = await open('ws://127.0.0.1:8767/chat');

    a.send(JSON.stringify({ event: 'join', data: { room: 'lobby' } }));
    b.send(JSON.stringify({ event: 'join', data: { room: 'lobby' } }));
    c.send(JSON.stringify({ event: 'join', data: { room: 'other' } }));
    await Promise.all([nextMessage(a), nextMessage(b), nextMessage(c)]);

    const aMsg = nextMessage(a);
    const bMsg = nextMessage(b);
    const cMsg = nextMessage(c);

    a.send(
      JSON.stringify({
        event: 'broadcast',
        data: { room: 'lobby', text: 'hi' },
      }),
    );

    // The publisher itself does NOT receive the broadcast (Bun behavior),
    // but the other lobby member does. The 'sent' ACK comes back to A.
    const ack = await aMsg;
    expect(ack.event).toBe('sent');
    expect(ack.data.room).toBe('lobby');

    const broadcast = await bMsg;
    expect(broadcast).toEqual({ event: 'message', data: { text: 'hi' } });

    // C is in another room — should not receive.
    const cReceived = await Promise.race([
      cMsg,
      new Promise(r => setTimeout(() => r('timeout'), 200)),
    ]);
    expect(cReceived).toBe('timeout');

    a.close();
    b.close();
    c.close();
  });

  it('unsubscribe stops further broadcasts to that client', async () => {
    const a = await open('ws://127.0.0.1:8767/chat');
    const b = await open('ws://127.0.0.1:8767/chat');
    a.send(JSON.stringify({ event: 'join', data: { room: 'r2' } }));
    b.send(JSON.stringify({ event: 'join', data: { room: 'r2' } }));
    await Promise.all([nextMessage(a), nextMessage(b)]);

    b.send(JSON.stringify({ event: 'leave', data: { room: 'r2' } }));
    await nextMessage(b);

    const aAck = nextMessage(a);
    const bMsg = nextMessage(b);
    a.send(
      JSON.stringify({
        event: 'broadcast',
        data: { room: 'r2', text: 'silent' },
      }),
    );

    const ack = await aAck;
    expect(ack.event).toBe('sent');
    expect(ack.data.delivered).toBe(0);

    const bReceived = await Promise.race([
      bMsg,
      new Promise(r => setTimeout(() => r('timeout'), 200)),
    ]);
    expect(bReceived).toBe('timeout');

    a.close();
    b.close();
  });
});

describe('platform-bun :: shared-port WebSocket (no explicit port)', () => {
  let app: any;
  let baseUrl: string;

  beforeAll(async () => {
    app = await bootApp([SharedGateway]);
    const { port } = app.getHttpServer().address();
    baseUrl = `ws://127.0.0.1:${port}`;
  });
  afterAll(async () => app.close());

  it('upgrades on the HTTP listen port (shared — no separate Bun.serve)', async () => {
    const ws = await open(`${baseUrl}/ws-shared`);
    ws.send(JSON.stringify({ event: 'ping', data: { v: 1 } }));
    const msg = await nextMessage(ws);
    expect(msg).toEqual({ event: 'pong-shared', data: { v: 1 } });
    ws.close();
  });

  it('matches a trailing-slash URL to the normalized gateway path', async () => {
    // Regression: wsPaths keys are stored normalized (no trailing slash); the
    // shared-port lookup must normalize the request path the same way so
    // `/ws-shared/` reaches the `/ws-shared` gateway (standalone already did).
    const ws = await open(`${baseUrl}/ws-shared/`);
    ws.send(JSON.stringify({ event: 'ping', data: { v: 2 } }));
    const msg = await nextMessage(ws);
    expect(msg).toEqual({ event: 'pong-shared', data: { v: 2 } });
    ws.close();
  });
});

describe('platform-bun :: BunWsAdapter messageParser', () => {
  let app: any;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [EchoGateway],
    }).compile();
    app = moduleRef.createNestApplication(new BunHttpAdapter(), {
      logger: false,
    });
    const wsAdapter = new BunWsAdapter(app, {
      messageParser: data => {
        const [event, payload] = JSON.parse(data.toString());
        return { event, data: payload };
      },
    });
    app.useWebSocketAdapter(wsAdapter);
    await app.init();
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => app.close());

  it('honors a tuple-style messageParser', async () => {
    const ws = await open('ws://127.0.0.1:8765/');
    ws.send(JSON.stringify(['push', { tuple: true }]));
    const msg = await nextMessage(ws);
    expect(msg).toEqual({ event: 'pop', data: { tuple: true } });
    ws.close();
  });
});
