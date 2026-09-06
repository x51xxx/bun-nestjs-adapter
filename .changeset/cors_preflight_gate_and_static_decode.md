---
'@trishchuk/bun-nestjs-adapter': patch
---

CORS now matches the `cors` package, and classic static mounts decode the path.

**Preflight handling.** `enableCors()` gained `preflightContinue` and
`optionsSuccessStatus`, the two options `cors` (which `@nestjs/platform-express`
uses) exposes for this. Every `OPTIONS` is treated as a preflight and ended with
`optionsSuccessStatus` — `204` by default — which is what both `cors` and
`@fastify/cors` do; pass `preflightContinue: true` to apply the preflight
headers and fall through to routing, so your own `@Options()` handler owns the
response.

**Preflight-only headers stay on the preflight.** `Access-Control-Allow-Methods`,
`Access-Control-Allow-Headers` and `Access-Control-Max-Age` describe a *future*
request and were going out on every response; they are now emitted only on a
preflight. `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials` and
`Access-Control-Expose-Headers` still go on both, matching `cors`.

**Classic static mounts percent-decode the path.** `/static/my%20file.txt` was a
404 while the same file served fine through `useStaticAssets(root, { native:
true })` — any asset with a space or a non-ASCII character in its name was
unreachable. Both modes now share the same per-segment decode, which is also the
traversal guard: a segment decoding to `.`, `..`, nothing, or hiding a separator
or `%00` is rejected (`403` classic, `404` native) instead of resolved.
