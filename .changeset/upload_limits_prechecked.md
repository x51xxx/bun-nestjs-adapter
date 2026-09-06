---
'@trishchuk/bun-nestjs-adapter': minor
---

Upload limits now guard memory, and the multipart interceptors match Multer's
error contract.

**`limits.totalSize` — a real pre-buffer guard.** `Request.formData()`
materialises every part before it returns, so `fileSize` and `files` could only
ever be checked once the bytes were already in memory: a 2 GB upload against
`fileSize: 1_000_000` was buffered in full and only then rejected. `totalSize`
is compared against `Content-Length` before the body is read, and it defaults to
`fileSize * <max files> + 1 MiB` whenever `fileSize` is set and the file count
is known — so existing code gets the protection without changing. Set it
explicitly to adjust the allowance, or to `Infinity` to opt out. A chunked
upload carries no `Content-Length` and still cannot be pre-checked.

**`maxCount` rejects instead of truncating.** `BunFilesInterceptor(field, 3)`
used to drop the fourth file silently, leaving the client believing it had
uploaded. It now throws `400 Unexpected field - <field>`, as Multer does.

**Several interceptors can share one route.** The parsed form is memoised on the
request, so the second interceptor no longer fails with `Body already used`.

**Messages match `@nestjs/platform-express`:** `File too large` (413),
`Too many files` (400), `Unexpected field - <field>` (400).
