# Documentation — @trishchuk/bun-nestjs-adapter

A native [Bun](https://bun.com) HTTP & WebSocket adapter for [NestJS](https://nestjs.com).
It runs a Nest app directly on `Bun.serve` (the Web-Fetch API surface) instead of
`node:http`, implementing `AbstractHttpAdapter` and `AbstractWsAdapter`
end-to-end.

## Guides

- [Getting started](./getting-started.md) — install, bootstrap, app options.
- [HTTP](./http.md) — routing & the fast path, body parsing, versioning, CORS,
  static assets, the `req`/`res` shims.
- [Streaming & SSE](./streaming-and-sse.md) — `StreamableFile`, Node `Readable`,
  `@Sse()`.
- [File uploads](./file-uploads.md) — `BunFileInterceptor` &amp; friends, size /
  count limits.
- [WebSockets](./websockets.md) — `BunWsAdapter`, shared-port vs. standalone,
  path routing, native pub/sub.
- [GraphQL](./graphql.md) — Apollo on bun, and the experimental `BunYogaDriver`.
- [Benchmarks](./benchmarks.md) — methodology and how to reproduce.
- [Architecture](./architecture.md) — internals: the two dispatch paths, the
  shims, dynamic route reload.

## At a glance

| Feature | Entry point |
| --- | --- |
| HTTP adapter | `BunHttpAdapter` |
| WebSocket adapter | `BunWsAdapter` |
| File uploads | `BunFileInterceptor`, `BunFilesInterceptor`, `BunAnyFilesInterceptor` |
| Static assets | `app.useStaticAssets(root, { prefix, index, native })` |
| Streaming | return `StreamableFile` or a Node `Readable` |
| SSE | `@Sse()` |

Everything above is exported from the package root:

```ts
import {
  BunHttpAdapter,
  BunWsAdapter,
  BunFileInterceptor,
  BunFilesInterceptor,
  BunAnyFilesInterceptor,
  type BunUploadedFile,
  type BunMultipartOptions,
} from '@trishchuk/bun-nestjs-adapter';
```

Runtime requirement: **Bun ≥ 1.2.0**. See also the top-level
[`README.md`](../README.md), [`BENCHMARK.md`](../BENCHMARK.md), and
[`KNOWN-LIMITATIONS.md`](../KNOWN-LIMITATIONS.md).
