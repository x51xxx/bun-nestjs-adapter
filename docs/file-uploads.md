# File uploads

Multipart uploads are read with Bun's native `Request.formData()` — no Multer,
no disk staging. Three interceptors mirror the `@nestjs/platform-express`
surface and populate `req.file` / `req.files`.

| Interceptor | Sets | Signature |
| --- | --- | --- |
| `BunFileInterceptor(field, options?)` | `req.file` | one file, from that field only |
| `BunFilesInterceptor(field, maxCount?, options?)` | `req.files` | files from that field only, at most `maxCount` |
| `BunAnyFilesInterceptor(options?)` | `req.files` | every file across all fields |

Each interceptor declares which file parts it accepts, and answers
`400 Unexpected field - <name>` for anything outside that — a file under a field
it wasn't asked for, or one file too many under a field it was. Text fields are
never policed by name, and a request carrying no file at all is fine. This
mirrors Multer; ignoring the extra part, as these used to, let a client upload
under the wrong field name, get a `201`, and never learn the file was dropped.

## The uploaded file shape

```ts
interface BunUploadedFile {
  fieldname: string;
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}
```

Files are buffered in memory (`buffer`), so set limits for any
publicly-reachable endpoint.

## Single file

```ts
import {
  BunFileInterceptor,
  type BunUploadedFile,
} from '@trishchuk/bun-nestjs-adapter';
import { Controller, Post, UploadedFile, UseInterceptors } from '@nestjs/common';

@Controller('uploads')
export class UploadsController {
  @Post()
  @UseInterceptors(BunFileInterceptor('avatar'))
  upload(@UploadedFile() file: BunUploadedFile) {
    return { name: file.originalname, size: file.size };
  }
}
```

## Limits

```ts
@UseInterceptors(
  BunFileInterceptor('avatar', {
    limits: {
      fileSize: 10 * 1024 * 1024, // bytes — per file, checked post-buffer
      files: 1,                   // max number of files, checked post-buffer
      totalSize: 12 * 1024 * 1024,// bytes — whole request, checked up front
    },
  }),
)
```

**Which of these actually protects memory.** Multer enforces `fileSize` while
the upload streams and aborts the connection mid-file. `Request.formData()`
gives no such hook: it materialises every part before it returns, so `fileSize`
and `files` can only be *checked* once the bytes are already in memory. They are
a response policy, not a memory guard.

`totalSize` is the guard that runs first — it is compared against
`Content-Length` before the body is touched. You rarely need to set it: it
defaults to `fileSize * <max files> + 1 MiB` whenever `fileSize` is set and the
file count is known, so

```ts
BunFileInterceptor('avatar', { limits: { fileSize: 1_000_000 } })
```

refuses a 2 GB upload up front instead of buffering it and then rejecting it.
Set it explicitly to widen or tighten the allowance (which covers text fields,
part headers and boundaries), or to `Infinity` to opt out.

A chunked upload carries no `Content-Length` and so cannot be pre-checked;
`Bun.serve`'s own `maxRequestBodySize` — 128 MB by default — is the backstop
there.

When a limit is exceeded the interceptor throws a standard Nest exception,
carrying the same message `@nestjs/platform-express` produces:

- **`PayloadTooLargeException`** (HTTP 413) — `File too large`: the request
  exceeds `totalSize`, or a file exceeds `limits.fileSize`.
- **`BadRequestException`** (HTTP 400) — `Too many files`: more files than
  `limits.files`.
- **`BadRequestException`** (HTTP 400) — `Unexpected field - <field>`: a file
  under a field the interceptor doesn't accept, or more files in one field than
  it accepts (`maxCount`, or one for `BunFileInterceptor`).

Several interceptors can share one route — the parsed form is memoised on the
request, so the second one does not hit `Body already used`. They do have to
agree about the form: a single-field interceptor rejects a file under any other
name, so pair one with `BunAnyFilesInterceptor()` rather than with a second
single-field interceptor.

## Multiple files

```ts
// up to 5 files from the "photos" field → req.files
@UseInterceptors(BunFilesInterceptor('photos', 5, { limits: { fileSize: 5_000_000 } }))
uploadMany(@UploadedFiles() files: BunUploadedFile[]) { /* … */ }

// every file across every field → req.files
@UseInterceptors(BunAnyFilesInterceptor({ limits: { files: 20 } }))
uploadAny(@UploadedFiles() files: BunUploadedFile[]) { /* … */ }
```

Non-file form fields are parsed too and remain available on the request body
map. Internally the interceptors read `req.bunRequest.formData()`, so the global
body parser intentionally leaves `multipart/*` requests untouched.

Next: [WebSockets →](./websockets.md)
