import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
  Type,
  mixin,
} from '@nestjs/common';
import { Observable, from, switchMap } from 'rxjs';

/**
 * Options for configuring multipart form-data parser limits.
 *
 * **What these can and cannot guarantee.** Multer enforces `fileSize` while the
 * upload streams, aborting the connection mid-file. There is no equivalent
 * through `Request.formData()`: it materialises every part before returning, so
 * `fileSize` and `files` can only be *checked* afterwards — by then the bytes
 * are already in memory. `totalSize` is the guard that actually runs first: it
 * is compared against `Content-Length` before the body is touched.
 */
export interface BunMultipartOptions {
  limits?: {
    /**
     * Max size of a single file, in bytes. Enforced **after** the part is in
     * memory (see above); the pre-flight guard derived from it is `totalSize`.
     */
    fileSize?: number;
    /** Max number of files across all fields. Also checked post-buffer. */
    files?: number;
    /**
     * Max size of the whole request, in bytes, checked against `Content-Length`
     * **before** `formData()` reads anything. This is the real memory guard.
     *
     * Defaults to `fileSize * <max files> + 1 MiB` (the allowance covers text
     * fields, part headers and boundaries) whenever `fileSize` is set and the
     * file count is known — so a 2 GB upload against `fileSize: 1_000_000` is
     * refused up front instead of being buffered and then rejected. Set it
     * explicitly to widen or tighten that, or to `Infinity` to opt out.
     *
     * A chunked upload carries no `Content-Length` and so cannot be pre-checked;
     * `Bun.serve`'s own `maxRequestBodySize` (128 MB by default) is the backstop
     * there.
     */
    totalSize?: number;
  };
}

/**
 * Room for text fields, part headers and boundaries on top of the file bytes
 * when `totalSize` is derived rather than given. 1 MiB matches Multer's default
 * `fieldSize`.
 */
const DERIVED_TOTAL_SIZE_SLACK = 1024 * 1024;

/**
 * Multer's own wording, so a client sees the same string it would from
 * `@nestjs/platform-express`. `transformException` there maps LIMIT_FILE_SIZE to
 * 413 and the rest to 400; these throw the mapped exceptions directly.
 */
const MULTER_MESSAGES = {
  fileSize: 'File too large',
  fileCount: 'Too many files',
  unexpectedField: (field: string) => `Unexpected field - ${field}`,
} as const;

/**
 * Shape exposed under `req.file` / `req.files` after the interceptor runs.
 * Mirrors the most common subset of Multer's File interface so existing
 * application code that reads `file.fieldname / originalname / mimetype /
 * size / buffer` keeps working unchanged.
 */
export interface BunUploadedFile {
  fieldname: string;
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** The duck-typed `File`-like entry FormData yields for uploads. */
interface FormDataFileEntry {
  arrayBuffer(): Promise<ArrayBuffer>;
  name: string;
  type: string;
}

/** The request fields the interceptors read and populate. */
interface MultipartRequest {
  bunRequest?: Request;
  body?: Record<string, unknown>;
  file?: BunUploadedFile;
  files?: BunUploadedFile[];
  /**
   * Memoised `formData()`. A Web `Request` body can be read exactly once, so
   * two interceptors on the same route used to make the second one throw
   * `Body already used`. Caching the promise lets them share one parse.
   */
  __bunFormData?: Promise<FormData>;
}

function isFileEntry(value: unknown): value is FormDataFileEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<FormDataFileEntry>).arrayBuffer === 'function'
  );
}

async function fileFromFormDataEntry(
  fieldname: string,
  value: FormDataFileEntry,
): Promise<BunUploadedFile> {
  const buffer = Buffer.from(await value.arrayBuffer());
  return {
    fieldname,
    originalname: value.name,
    mimetype: value.type || 'application/octet-stream',
    size: buffer.length,
    buffer,
  };
}

/**
 * Whole-request ceiling to enforce before reading the body: `totalSize` when
 * given, otherwise derived from `fileSize` and the known file count. `Infinity`
 * (explicit, or "nothing to derive from") means no pre-check.
 */
function totalSizeLimit(
  limits: BunMultipartOptions['limits'],
  maxFiles: number | undefined,
): number {
  if (limits?.totalSize !== undefined) return limits.totalSize;
  if (limits?.fileSize === undefined) return Number.POSITIVE_INFINITY;
  const count = limits.files ?? maxFiles;
  if (count === undefined) return Number.POSITIVE_INFINITY;
  return limits.fileSize * count + DERIVED_TOTAL_SIZE_SLACK;
}

/**
 * Refuse an over-sized upload from its `Content-Length`, before `formData()`
 * materialises a single byte. This is the only check here that runs early
 * enough to protect memory — everything below it is policy applied to data that
 * has already been read.
 */
function assertWithinTotalSize(source: Request, limit: number): void {
  if (limit === Number.POSITIVE_INFINITY) return;
  const declared = source.headers.get('content-length');
  if (declared === null) return; // chunked — nothing to check against
  const length = Number(declared);
  if (Number.isFinite(length) && length > limit) {
    throw new PayloadTooLargeException(MULTER_MESSAGES.fileSize);
  }
}

async function readFormData(
  req: MultipartRequest,
  options?: BunMultipartOptions,
  maxFiles?: number,
): Promise<{
  fields: Record<string, string>;
  filesByField: Map<string, BunUploadedFile[]>;
}> {
  const source: Request | undefined = req?.bunRequest;
  if (!source) {
    throw new Error(
      'BunFileInterceptor: req.bunRequest is missing — is this running under @nestjs/platform-bun?',
    );
  }
  const limits = options?.limits;
  assertWithinTotalSize(source, totalSizeLimit(limits, maxFiles));

  // Memoised: a second interceptor on the same route would otherwise get
  // `Body already used` off the already-consumed Web Request.
  const fd: FormData = await (req.__bunFormData ??= source.formData());
  const fields: Record<string, string> = {};
  const filesByField = new Map<string, BunUploadedFile[]>();
  let totalFiles = 0;

  for (const [key, value] of fd.entries()) {
    if (typeof value === 'string') {
      fields[key] = value;
    } else if (isFileEntry(value)) {
      totalFiles++;
      if (limits?.files !== undefined && totalFiles > limits.files) {
        throw new BadRequestException(MULTER_MESSAGES.fileCount);
      }
      const file = await fileFromFormDataEntry(key, value);
      if (limits?.fileSize !== undefined && file.size > limits.fileSize) {
        throw new PayloadTooLargeException(MULTER_MESSAGES.fileSize);
      }
      const arr = filesByField.get(key);
      if (arr) arr.push(file);
      else filesByField.set(key, [file]);
    }
  }
  return { fields, filesByField };
}

/**
 * @publicApi
 *
 * Single-file upload interceptor. Mirrors `FileInterceptor()` from
 * `@nestjs/platform-express` but reads the multipart body via
 * `Bun.serve`'s native `Request.formData()`.
 *
 * Usage:
 *   ```ts
 *   @Post('upload')
 *   @UseInterceptors(BunFileInterceptor('avatar'))
 *   upload(@UploadedFile() file: BunUploadedFile) { ... }
 *   ```
 */
export function BunFileInterceptor(
  fieldName: string,
  options?: BunMultipartOptions,
): Type<NestInterceptor> {
  @Injectable()
  class MixinInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
      const req = context.switchToHttp().getRequest<MultipartRequest>();
      return from(readFormData(req, options, 1)).pipe(
        switchMap(({ fields, filesByField }) => {
          req.body = { ...(req.body ?? {}), ...fields };
          const found = filesByField.get(fieldName);
          req.file = found?.[0];
          return next.handle();
        }),
      );
    }
  }
  return mixin(MixinInterceptor);
}

/**
 * @publicApi
 *
 * Multi-file upload interceptor. Sets `req.files` to the array of files
 * uploaded under `fieldName`. Exceeding the optional `maxCount` is a
 * `400 Unexpected field`, the way Multer answers it.
 */
export function BunFilesInterceptor(
  fieldName: string,
  maxCount?: number,
  options?: BunMultipartOptions,
): Type<NestInterceptor> {
  @Injectable()
  class MixinInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
      const req = context.switchToHttp().getRequest<MultipartRequest>();
      return from(readFormData(req, options, maxCount)).pipe(
        switchMap(({ fields, filesByField }) => {
          req.body = { ...(req.body ?? {}), ...fields };
          const list = filesByField.get(fieldName) ?? [];
          // Multer answers 400 `Unexpected field` for the file past the limit.
          // Silently dropping it, as this used to, loses an upload the client
          // believes succeeded.
          if (maxCount !== undefined && list.length > maxCount) {
            throw new BadRequestException(MULTER_MESSAGES.unexpectedField(fieldName));
          }
          req.files = list;
          return next.handle();
        }),
      );
    }
  }
  return mixin(MixinInterceptor);
}

/**
 * @publicApi
 *
 * Reads any number of files across any number of fields. Sets
 * `req.files` to an object keyed by fieldname.
 */
export function BunAnyFilesInterceptor(
  options?: BunMultipartOptions,
): Type<NestInterceptor> {
  @Injectable()
  class MixinInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
      const req = context.switchToHttp().getRequest<MultipartRequest>();
      return from(readFormData(req, options)).pipe(
        switchMap(({ fields, filesByField }) => {
          req.body = { ...(req.body ?? {}), ...fields };
          const flat: BunUploadedFile[] = [];
          for (const arr of filesByField.values()) flat.push(...arr);
          req.files = flat;
          return next.handle();
        }),
      );
    }
  }
  return mixin(MixinInterceptor);
}
