---
'@trishchuk/bun-nestjs-adapter': minor
---

Add a native Bun TCP microservices transport, exported from the new
`@trishchuk/bun-nestjs-adapter/microservices` subpath.

- `BunServerTcp` — a Nest `CustomTransportStrategy` built on `Bun.listen()`.
- `BunClientTcp` — a `ClientProxy` built on `Bun.connect()`.
- `BunJsonSocket` — length-prefixed JSON framing matching Nest's built-in TCP
  transport, so both classes are wire-compatible with stock `ServerTCP` /
  `ClientTCP` in either direction.

`@nestjs/microservices` is an optional peer dependency and is shipped from a
separate entry point, so HTTP/WS-only consumers never pull it into the bundle.
