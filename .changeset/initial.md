---
'@trishchuk/bun-nestjs-adapter': minor
---

Initial public release of the Bun adapter for NestJS.

- `BunHttpAdapter` — native `Bun.serve` HTTP adapter with a `Bun.serve({ routes })` fast path.
- `BunWsAdapter` — WebSocket adapter on top of `Bun.serve({ websocket })` with native pub/sub.
- `BunFileInterceptor` family for multipart uploads via `Request.formData()`.
- `StreamableFile` / Node `Readable` streaming and `@Sse()` support.
- Versioning (URI / HEADER / MEDIA_TYPE / CUSTOM), CORS, static assets.
