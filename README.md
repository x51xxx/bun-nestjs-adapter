# @trishchuk/bun-nestjs-adapter

> Native [Bun](https://bun.com) HTTP & WebSocket adapter for [NestJS](https://nestjs.com).

[![CI](https://github.com/x51xxx/bun-nestjs-adapter/actions/workflows/ci.yml/badge.svg)](https://github.com/x51xxx/bun-nestjs-adapter/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun%201.3+-fbf0df)](https://bun.com)

`platform-bun` runs a NestJS application directly on top of `Bun.serve` — the
Web-Fetch API surface — instead of going through `node:http`.

It implements `AbstractHttpAdapter` and `AbstractWsAdapter` end-to-end, with a
fast path that hands routing to Bun's native C++ matcher (`Bun.serve({ routes })`)
whenever no middleware/static/CORS feature is active.

## What's in the box

- **HTTP**: all verbs, JSON / urlencoded / text body parsing, multi-match
  dispatch (header / media-type / custom versioning), `applyVersionFilter` for
  URI / HEADER / MEDIA_TYPE / CUSTOM, CORS, Express-compatible `req` / `res`
  shim methods.
- **Static assets** via `Bun.file()` (`useStaticAssets(root, { prefix, index })`).
- **Streaming**: `StreamableFile` and bare Node `Readable` returns are converted
  to a Web `ReadableStream` and piped through `Bun.serve`.
- **Server-Sent Events** (`@Sse()`) — the response carries a Node-`Writable`
  shim and the request bridges `AbortSignal` to `'close'` so Nest's core
  `RouterResponseController.sse()` works unchanged.
- **File uploads**: `BunFileInterceptor`, `BunFilesInterceptor`,
  `BunAnyFilesInterceptor` — read multipart bodies via the native
  `Request.formData()` and populate `req.file` / `req.files`. Optional
  `limits` (`fileSize`, `files`) reject oversized / too-many-file uploads.
- **WebSocket**: `BunWsAdapter` on top of `Bun.serve({ websocket })` with shim
  EventEmitters that map Bun callbacks to Node-`ws` events; native pub/sub
  (`client.subscribe / unsubscribe / publish`, `server.publish`). A
  `@WebSocketGateway()` with **no port (or the HTTP port) shares the main
  `Bun.serve`** via HTTP upgrade — no second listener; an explicit *different*
  port still spins up its own server.

## Documentation

Full guides live in [`docs/`](./docs/README.md):
[Getting started](./docs/getting-started.md) ·
[HTTP](./docs/http.md) ·
[Streaming & SSE](./docs/streaming-and-sse.md) ·
[File uploads](./docs/file-uploads.md) ·
[WebSockets](./docs/websockets.md) ·
[GraphQL](./docs/graphql.md) ·
[Benchmarks](./docs/benchmarks.md) ·
[Architecture](./docs/architecture.md).

## Install

```bash
bun add @trishchuk/bun-nestjs-adapter
# peer deps if not already in your tree:
bun add @nestjs/common @nestjs/core @nestjs/websockets rxjs reflect-metadata
```

## Quick start

```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { BunHttpAdapter, BunWsAdapter } from '@trishchuk/bun-nestjs-adapter';
import { AppModule } from './app.module';

const app = await NestFactory.create(AppModule, new BunHttpAdapter());
app.useWebSocketAdapter(new BunWsAdapter(app)); // optional
await app.listen(3000);
```

### File uploads (with Safety Limits)

Upload interceptors mirror the behavior of `@nestjs/platform-express` but read multipart bodies asynchronously via Bun's native `Request.formData()` without importing Multer.

You can configure limits (`fileSize` in bytes, `files` count) to prevent out-of-memory errors from oversized uploads:

```ts
import {
  BunFileInterceptor,
  type BunUploadedFile,
} from '@trishchuk/bun-nestjs-adapter';
import { Controller, Post, UploadedFile, UseInterceptors } from '@nestjs/common';

@Controller('uploads')
export class UploadsController {
  @Post()
  @UseInterceptors(
    BunFileInterceptor('avatar', {
      limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
        files: 1,                  // max 1 file
      },
    }),
  )
  upload(@UploadedFile() file: BunUploadedFile) {
    return { name: file.originalname, size: file.size };
  }
}
```

If limits are exceeded, a standard NestJS exception is thrown:
- `PayloadTooLargeException` (HTTP 413) if `fileSize` is exceeded.
- `BadRequestException` (HTTP 400) if `files` count is exceeded.

There are also `BunFilesInterceptor(fieldName, maxCount, options)` and `BunAnyFilesInterceptor(options)` for multiple fields/files.

### WebSockets (Shared Port or Explicit Listener)

When you use `BunWsAdapter`, `@WebSocketGateway()` gateways can share the main HTTP server port (no separate listener required) or spin up a dedicated server on another port.

To share the HTTP port, configure the gateway **without a port** (or set it to `0` or the HTTP port):

```ts
import { WebSocketGateway, WebSocketServer, SubscribeMessage, MessageBody } from '@nestjs/websockets';

@WebSocketGateway({ path: '/ws' })
export class ChatGateway {
  @WebSocketServer()
  server: any;

  @SubscribeMessage('ping')
  handlePing(@MessageBody() data: any) {
    return { event: 'pong', data };
  }
}
```

Under the hood, `BunHttpAdapter` intercepts WebSocket upgrade requests and upgrades them using Bun's native `server.upgrade` callback, passing client connection data to the ws adapter server instance.

### Dynamic Route Reloading (Lazy Modules)

If you load routes dynamically at runtime (for example, using Nest's `LazyModuleLoader`), `BunHttpAdapter` automatically intercepts new route/middleware additions and calls `server.reload({ routes })` to refresh the native `Bun.serve` routing tables. No manual action or server restart is required.

### SSE

```ts
import { Controller, Sse } from '@nestjs/common';
import { interval, map } from 'rxjs';

@Controller('events')
export class EventsController {
  @Sse()
  stream() {
    return interval(1000).pipe(map(t => ({ data: { tick: t } })));
  }
}
```

## How it stacks up

Single-route `GET /` benchmark on M-series Mac, 50 concurrent connections,
30 seconds, **measured under a Bun-native fetch client** (autocannon's Node
HTTP client systematically under-counts Bun.serve — see
[`tests/bench/bun-bench.ts`](./tests/bench/bun-bench.ts)):

| Target | RPS | p50 / p99 (ms) |
| --- | ---: | ---: |
| `bun` (raw) | 130 308 | 0.42 / 0.91 |
| **`nest-bun` (this adapter)** | **102 319** | **0.42 / 1.00** |
| `nest-fastify` | 84 936 | 0.53 / 1.29 |
| `nest-express` | 69 011 | 0.66 / 1.61 |

So Nest-Bun is **+22 % vs nest-fastify** and **+48 % vs nest-express** in RPS,
with p99 latency 23–38 % lower. Numbers fluctuate ±15 % across runs due to
thermal throttling — re-measure on your hardware:

```bash
bun run bench
# or:
bun run bench:quick   # 5 s × 50 connections
```

For a fuller picture — a GraphQL-vs-REST matrix across bun / express / fastify
(driven by external **k6** so the load generator never shares a runtime with
the server under test), plus an Apollo-vs-Yoga-on-bun comparison — see
[`BENCHMARK.md`](./BENCHMARK.md) (`bun run bench:matrix`).

## Compatibility test against upstream nestjs/nest fixtures

`tests/integration/upstream-fixtures.spec.ts` boots `BunHttpAdapter` against
the real `integration/hello-world`, `integration/versioning`, `integration/cors`
and friends from the upstream `nestjs/nest` repository (loaded as a git
submodule under `fixtures/nestjs-nest/`):

```bash
bun run fixtures:install   # one-time: clone submodule + build nest packages
bun run test:fixtures      # run our compatibility suite against them
```

This means every regression in upstream Nest core is automatically picked up
by our CI. Update with `bun run fixtures:update`.

## Development

```bash
bun install
bun run typecheck
bun run lint
bun run test
bun run build       # tsup → dist/{index.js, index.cjs, index.d.ts}
```

### Repository layout

```
src/                          # source — published as @trishchuk/bun-nestjs-adapter
  adapters/
    bun-http-adapter.ts       # BunHttpAdapter (~1.6k LOC)
    bun-ws-adapter.ts         # BunWsAdapter
  interceptors/
    bun-file-interceptor.ts   # BunFileInterceptor & friends
  index.ts

tests/
  preload.ts                  # reflect-metadata + Mocha-shim
  integration/                # our own e2e specs (fetch client)
    fixtures/own/             # local AppModules / controllers
    upstream-fixtures.spec.ts # smoke-tests vs upstream nestjs/nest fixtures
  bench/
    bun-bench.ts              # parallel-fetch benchmark runner
    frameworks/               # express / fastify / bun / nest-* targets

fixtures/
  nestjs-nest/                # git submodule, pinned to a known-good SHA

scripts/
  fixtures-install.sh         # clone submodule + build upstream nest
  fixtures-update.sh          # bump submodule SHA
```

## Roadmap

- [x] Shared-port WebSocket upgrade — `@WebSocketGateway()` with no port shares
      the HTTP server's `Bun.serve`.
- [~] GraphQL Yoga driver (`BunYogaDriver`) — fetch-native driver prototyped and
      benchmarked (bench-only, ~+40 % RPS vs Apollo on bun); not yet a published
      export.
- [ ] `setViewEngine` + `render()` (currently throw).
- [ ] Cookie helper (signed cookies, parser).
- [ ] Unix-socket binding for inter-process traffic (Bun supports it natively).

## Prior art

- [`@krisanalfa/bunest-adapter`](https://github.com/krisanalfa/bunest) — the
  most mature community native-Bun adapter; ships `BunYogaDriver`, file
  uploads, SSE, streaming. Different routing strategy (own middleware engine
  rather than `Bun.serve({ routes })`).
- [`@kiyasov/platform-hono`](https://github.com/kiyasov/platform-hono) — wraps
  Hono, runs under Bun / Deno / Node. Not a native-Bun adapter (uses Hono's
  router on top).
- Upstream tickets: [Bun #1641](https://github.com/oven-sh/bun/issues/1641),
  [Nest #13073](https://github.com/nestjs/nest/issues/13073),
  [Nest #13881](https://github.com/nestjs/nest/issues/13881).

## License

[MIT](./LICENSE)
