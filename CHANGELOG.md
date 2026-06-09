# @trishchuk/bun-nestjs-adapter

## 0.2.0

### Minor Changes

- 9b9dc57: HTTPS support and HTTP adapter decomposition.

  - `NestApplicationOptions.httpsOptions` now reaches `Bun.serve({ tls })` via `initHttpServer()`.
  - Split the monolithic `bun-http-adapter.ts` (~1,600 LOC) into focused `src/http/` modules:
    router, server (`Bun.serve` wrapper + TLS), request/response shims, cookies, CORS,
    versioning, views, static assets, streaming, shared types.

- 8b898f4: View engine and cookie support.

  - `setViewEngine()` / `render()` with EJS, Pug, and Handlebars (lazy-loaded optional peers).
  - Cookie parsing on `req.cookies` / `req.signedCookies` and `res.cookie()` / `res.clearCookie()`.

### Patch Changes

- 9b9dc57: Fixes found during the decomposition.

  - `req.url` kept the protocol/host part for root requests with a query string.
  - Malformed percent-encoding in route params or cookies returned 500 instead of being tolerated.
  - A static-asset miss (registered prefix, file not on disk) hard-404ed instead of falling
    through to route dispatch.

## 0.1.0

### Minor Changes

- e6fb0f4: Initial public release of the Bun adapter for NestJS.

  - `BunHttpAdapter` — native `Bun.serve` HTTP adapter with a `Bun.serve({ routes })` fast path.
  - `BunWsAdapter` — WebSocket adapter on top of `Bun.serve({ websocket })` with native pub/sub.
  - `BunFileInterceptor` family for multipart uploads via `Request.formData()`.
  - `StreamableFile` / Node `Readable` streaming and `@Sse()` support.
  - Versioning (URI / HEADER / MEDIA_TYPE / CUSTOM), CORS, static assets.
