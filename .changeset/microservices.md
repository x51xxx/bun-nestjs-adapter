---
'@trishchuk/bun-nestjs-adapter': minor
---

Add native Bun microservices transports, exported from the new
`@trishchuk/bun-nestjs-adapter/microservices` subpath.

- `BunServerTcp` / `BunClientTcp` — TCP transport on `Bun.listen()` /
  `Bun.connect()`, with `BunJsonSocket` length-prefixed JSON framing matching
  Nest's built-in TCP transport.
- `BunServerRedis` / `BunClientRedis` — Redis Pub/Sub transport on
  `Bun.RedisClient`, using Nest's `pattern` / `pattern.reply` channel scheme.

All four are wire-compatible with stock Nest `ServerTCP`/`ClientTCP` and
`ServerRedis`/`ClientRedis` in either direction.

`@nestjs/microservices` is an optional peer dependency and is shipped from a
separate entry point, so HTTP/WS-only consumers never pull it into the bundle.
