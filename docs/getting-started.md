# Getting started

## Install

```bash
bun add @trishchuk/bun-nestjs-adapter
# peer deps, if not already in your tree:
bun add @nestjs/common @nestjs/core rxjs reflect-metadata
# only if you use gateways:
bun add @nestjs/websockets
```

Peer dependencies: `@nestjs/common` and `@nestjs/core` (`^10 || ^11`), `rxjs`
(`^7`). `@nestjs/websockets` is an **optional** peer — install it only if you
use `BunWsAdapter`. The package itself ships no runtime dependency beyond
`tslib`.

## Bootstrap

```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { BunHttpAdapter } from '@trishchuk/bun-nestjs-adapter';
import { AppModule } from './app.module';

const app = await NestFactory.create(AppModule, new BunHttpAdapter());
await app.listen(3000);
```

`BunHttpAdapter` is a drop-in `AbstractHttpAdapter`. Controllers, pipes, guards,
interceptors, filters, and DI work exactly as on `@nestjs/platform-express` —
the difference is the transport (`Bun.serve`, not `node:http`).

To add WebSocket gateways, also set the WS adapter (see
[WebSockets](./websockets.md)):

```ts
import { BunWsAdapter } from '@trishchuk/bun-nestjs-adapter';
app.useWebSocketAdapter(new BunWsAdapter(app));
```

## Relevant app options

`NestFactory.create(AppModule, new BunHttpAdapter(), options)` honours the
standard Nest options that matter for this adapter:

| Option | Effect |
| --- | --- |
| `{ rawBody: true }` | Populates `req.rawBody` (a `Buffer`) alongside the parsed `req.body`. Off by default — the JSON fast path hands bytes straight to Bun's native parser without materialising the raw buffer. |
| `{ bodyParser: false }` | Disables body parsing entirely. Use it when something downstream reads the raw request itself (e.g. GraphQL Yoga — see [GraphQL](./graphql.md)). |
| `{ logger: … }` | Standard Nest logger control. |

```ts
// raw body available for webhook signature checks, etc.
const app = await NestFactory.create(AppModule, new BunHttpAdapter(), {
  rawBody: true,
});
```

## Scripts you'll use

```bash
bun run build       # tsup → dist/{index.js, index.cjs, index.d.ts}
bun run typecheck   # tsc --noEmit
bun run test        # bun:test integration suite
bun run bench       # single-route HTTP benchmark
```

Next: [HTTP features →](./http.md)
