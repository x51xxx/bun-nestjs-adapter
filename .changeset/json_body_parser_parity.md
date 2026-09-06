---
'@trishchuk/bun-nestjs-adapter': minor
---

JSON body parsing now matches `body-parser`, which is what
`@nestjs/platform-express` runs. Every case below was read off a real
platform-express app before it was implemented.

**An empty JSON payload is `{}`.** It used to be `undefined`, which quietly
broke a `ValidationPipe` over a DTO whose fields are all optional — `{}`
validates, `undefined` does not. Covers all three shapes an empty payload
arrives in: `Content-Length: 0`, no body at all, and a chunked stream that
closes immediately. Each request gets its own object.

**A bare JSON scalar is rejected with 400.** `body-parser` runs with
`strict: true` by default: only an object or an array is a valid top-level JSON
body, so `null`, `123`, `true`, `"str"` and a whitespace-only payload are
answered with `400 Bad Request` rather than handed to the handler.

**This is a behaviour change for anything that posts top-level JSON scalars** —
they used to be accepted. Use `{ bodyParser: false }` and parse the body
yourself if you need to keep taking them.
