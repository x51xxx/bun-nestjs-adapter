---
'@trishchuk/bun-nestjs-adapter': minor
---

Expand HTTP/WS feature coverage, mostly on native Bun primitives:

- **BunHttpAdapter options**: `maxRequestBodySize`, `idleTimeout`, `reusePort`,
  `trustProxy`, `compression` (gzip/deflate/zstd), and `etag` (auto weak/strong
  ETag + `If-None-Match` → 304 for buffered GET/HEAD responses).
- **Connection info**: real `req.ip` via `server.requestIP()`, plus `req.ips` /
  `req.protocol` / `req.secure` (forwarding headers honoured only under
  `trustProxy`).
- **Static assets**: byte ranges (206), conditional requests (304),
  ETag/Last-Modified/Accept-Ranges and `Cache-Control` (`cacheControl`/`maxAge`).
- **res.sendFile() / res.download()** backed by `Bun.file()` with the same
  range/conditional/caching support.
- **Content negotiation**: `req.accepts` / `acceptsEncodings` / `acceptsLanguages`
  / `is` / `range`, and `res.format` / `jsonp` / `attachment` / `location` /
  `vary` / `append`.
- **Cookies** parsed via `Bun.CookieMap` (native), keeping signed + JSON support.
- **WebSocket tuning** (`BunWsAdapter` `{ websocket }`): `maxPayloadLength`,
  `perMessageDeflate`, `idleTimeout`, `backpressureLimit`, `sendPings`, etc.
- **File uploads**: a `dest` disk-storage option that streams uploads to disk via
  `Bun.write` instead of buffering in memory.
