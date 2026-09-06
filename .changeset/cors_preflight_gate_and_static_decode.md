---
'@trishchuk/bun-nestjs-adapter': patch
---

Fix two more defects from the 2026-09-06 audit.

**`enableCors()` no longer swallows your own `@Options()` routes.** Every
`OPTIONS` request was short-circuited to `204` the moment CORS was enabled, so
an `@Options()` handler never ran. Only a real preflight — one carrying
`Access-Control-Request-Method`, which is the gate the `cors` package uses — is
answered that way now; a plain `OPTIONS` goes through normal routing and 404s
on an unowned path exactly as it does with CORS off. CORS headers are applied
to both.

**Classic static mounts percent-decode the path.** `/static/my%20file.txt` was
a 404 while the same file served fine through `useStaticAssets(root, { native:
true })` — any asset with a space or a non-ASCII character in its name was
unreachable. Both modes now share the same per-segment decode, which is also
the traversal guard: a segment decoding to `.`, `..`, nothing, or hiding a
separator or `%00` is rejected (`403` classic, `404` native) instead of
resolved.
