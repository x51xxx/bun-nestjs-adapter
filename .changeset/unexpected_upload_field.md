---
'@trishchuk/bun-nestjs-adapter': minor
---

Upload interceptors now reject a file under a field they weren't asked for.

`BunFileInterceptor('avatar')` used to ignore a file arriving under any other
field name, so a client could upload under the wrong name, get a `201`, and
never learn the file had been dropped. Each interceptor now declares which file
parts it accepts and answers `400 Unexpected field - <name>` for anything
outside that — matching Multer:

- `BunFileInterceptor(field)` — one file, under that field only.
- `BunFilesInterceptor(field, maxCount)` — files under that field only, at most
  `maxCount`.
- `BunAnyFilesInterceptor()` — everything, as before.

Text fields are never policed by name, and a request carrying no file at all is
still fine.

**This is a behaviour change** for forms that carry file parts the interceptor
was not asked for: they used to be silently ignored and are now a 400. Use
`BunAnyFilesInterceptor()` if you want to keep accepting them. Note this also
means two single-field interceptors can no longer share one route, since each
rejects the other's field — pair one with `BunAnyFilesInterceptor()` instead.
