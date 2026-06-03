# WebSockets

`BunWsAdapter` implements Nest's `AbstractWsAdapter` on top of
`Bun.serve({ websocket })`. Connections are wrapped in EventEmitter shims that
map Bun's callbacks to the Node-`ws` contract Nest gateways expect, and Bun's
native pub/sub is exposed for broadcasts.

`@nestjs/websockets` is an **optional** peer dependency — install it only if you
use gateways.

## Enable it

```ts
import { BunHttpAdapter, BunWsAdapter } from '@trishchuk/bun-nestjs-adapter';

const app = await NestFactory.create(AppModule, new BunHttpAdapter());
app.useWebSocketAdapter(new BunWsAdapter(app));
await app.listen(3000);
```

Pass the app (not the raw server) so the adapter can find the
`BunHttpAdapter` for shared-port mode.

## Shared port vs. standalone

`@WebSocketGateway()` picks one of two modes:

- **Shared port** — no port, port `0`, or a port equal to the HTTP listen port.
  The gateway path is registered with the HTTP adapter, and upgrades happen on
  the **main `Bun.serve`** via `server.upgrade()` inside the HTTP dispatcher. No
  second listener.
- **Standalone** — an explicit *different* port spins up its own `Bun.serve` for
  that gateway.

```ts
// Shared: upgrades on the app's HTTP port (3000) at path /ws
@WebSocketGateway({ path: '/ws' })
export class ChatGateway { /* … */ }

// Standalone: dedicated listener on :8081
@WebSocketGateway(8081, { path: '/admin' })
export class AdminGateway { /* … */ }
```

Multiple gateways can share one port on **different paths**; a connection to an
unregistered path is rejected.

## A gateway

```ts
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
} from '@nestjs/websockets';

@WebSocketGateway({ path: '/ws' })
export class ChatGateway {
  @WebSocketServer() server: any;

  @SubscribeMessage('ping')
  handlePing(@MessageBody() data: unknown) {
    return { event: 'pong', data };
  }
}
```

The default message parser is `JSON.parse`. The handler's return value is sent
back JSON-encoded.

## Native pub/sub

Bun's topic-based pub/sub is exposed without a room abstraction:

- on a client: `client.subscribe(topic)`, `client.unsubscribe(topic)`,
  `client.isSubscribed(topic)`, `client.publish(topic, data)` (excludes the
  sender),
- on the server (`@WebSocketServer()`): `server.publish(topic, data)`
  (broadcasts to every subscriber).

```ts
@SubscribeMessage('join')
join(client: any, room: string) {
  client.subscribe(room);
}

@SubscribeMessage('broadcast')
broadcast(client: any, { room, text }: { room: string; text: string }) {
  this.server.publish(room, JSON.stringify({ event: 'message', data: { text } }));
}
```

## Custom message parser

If your clients don't send JSON objects, supply a parser:

```ts
app.useWebSocketAdapter(
  new BunWsAdapter(app, {
    // e.g. tuple framing: ['event', payload]
    messageParser: data => {
      const [event, payload] = JSON.parse(data.toString());
      return { event, data: payload };
    },
  }),
);
```

## Not supported

- **Namespaces** (`@WebSocketGateway({ namespace })`) — `create()` throws.
  Namespaces are a socket.io feature; use path-based routing + Bun topics
  instead, or socket.io if you need them. See
  [`KNOWN-LIMITATIONS.md`](../KNOWN-LIMITATIONS.md).

Next: [GraphQL →](./graphql.md)
