---
'@trishchuk/bun-nestjs-adapter': patch
---

Two more parity fixes from the 2026-09-06 audit, both measured against
`@nestjs/platform-express` first.

**Static mounts on one prefix are all consulted.** Only the first root covering
a path was ever tried, so a second `useStaticAssets(root, { prefix })` on the
same prefix was dead weight. They now chain in registration order — the first
one holding the file wins, the next answers what the previous lacks, and route
dispatch still runs once they all miss — the same behaviour `serve-static` gets
from `next()`.

**A malformed JSON body is answered with 400.** The parse error was swallowed
and the handler ran with `req.body === undefined`, which surfaced later as a
confusing DTO-validation failure or, on a route without validation, not at all.
The `SyntaxError` is now wrapped in `BadRequestException` and rendered by Nest's
error handler, so the response matches platform-express:
`{"message":…,"error":"Bad Request","statusCode":400}`. `req.rawBody` is still
populated for the rejected payload, and only `application/json` is policed this
way.
