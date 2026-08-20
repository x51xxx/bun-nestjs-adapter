---
'@trishchuk/bun-nestjs-adapter': minor
---

Classic `useStaticAssets()` mounts now send cache validators and answer conditional requests.

A classic mount replied `200` with the whole file every time: no `ETag`, no
`Last-Modified`, so a browser could never revalidate — `@nestjs/platform-express`
has done both by default for years through `serve-static`. `serveStatic()` now
emits a weak `ETag` and `Last-Modified` and answers `304` (empty body) to a
matching `If-None-Match` or `If-Modified-Since`.

The `ETag` uses the same formula as Bun's native `{ dir }` route, so the classic
and `native: true` modes hand out byte-identical validators for the same file —
switching a mount from one to the other does not invalidate what clients already
cached. That equality is asserted in `tests/integration/static-assets.spec.ts`.

`Range` needed no work: from Bun 1.4.0 a `Bun.file` body answers `206` on its
own, rewriting the `content-length` we set. Both are now covered by tests, the
`206` one gated on the runtime version.
