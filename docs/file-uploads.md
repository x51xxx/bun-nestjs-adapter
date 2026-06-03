# File uploads

Multipart uploads are read with Bun's native `Request.formData()` — no Multer,
no disk staging. Three interceptors mirror the `@nestjs/platform-express`
surface and populate `req.file` / `req.files`.

| Interceptor | Sets | Signature |
| --- | --- | --- |
| `BunFileInterceptor(field, options?)` | `req.file` | single file from one field |
| `BunFilesInterceptor(field, maxCount?, options?)` | `req.files` | up to `maxCount` files from one field |
| `BunAnyFilesInterceptor(options?)` | `req.files` | every file across all fields |

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

Pass `options.limits` to reject oversized or too-many-file uploads before they
buffer fully:

```ts
@UseInterceptors(
  BunFileInterceptor('avatar', {
    limits: {
      fileSize: 10 * 1024 * 1024, // bytes — per file
      files: 1,                   // max number of files
    },
  }),
)
```

```ts
interface BunMultipartOptions {
  limits?: {
    fileSize?: number; // max bytes per file
    files?: number;    // max number of files
  };
}
```

When a limit is exceeded the interceptor throws a standard Nest exception:

- **`PayloadTooLargeException`** (HTTP 413) — a file exceeds `limits.fileSize`.
- **`BadRequestException`** (HTTP 400) — more files than `limits.files`.

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
