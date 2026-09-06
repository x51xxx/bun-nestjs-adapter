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
 * Which file parts an interceptor is willing to accept. Multer models this as a
 * `fields` spec and answers `LIMIT_UNEXPECTED_FILE` for anything outside it —
 * a file under a field it wasn't asked for, or one file too many under a field
 * it was. Both come back as `400 Unexpected field - <name>`; text fields are
 * never policed by name.
 */
interface FieldPolicy {
  /** `null` accepts every field name — `BunAnyFilesInterceptor`. */
  field: string | null;
  /** Files accepted under that field. `Infinity` for "as many as arrive". */
  maxCount: number;
}

/**
 * Whole-request ceiling to enforce before reading the body: `totalSize` when
 * given, otherwise derived from `fileSize` and the known file count. `Infinity`
 * (explicit, or "nothing to derive from") means no pre-check.
 */
function totalSizeLimit(
  limits: BunMultipartOptions['limits'],
  policy: FieldPolicy,
): number {
  if (limits?.totalSize !== undefined) return limits.totalSize;
  if (limits?.fileSize === undefined) return Number.POSITIVE_INFINITY;
  const count = Number.isFinite(policy.maxCount) ? policy.maxCount : limits.files;
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
  policy: FieldPolicy,
  options?: BunMultipartOptions,
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
  assertWithinTotalSize(source, totalSizeLimit(limits, policy));

  // Memoised: a second interceptor on the same route would otherwise get
  // `Body already used` off the already-consumed Web Request.
  const fd: FormData = await (req.__bunFormData ??= source.formData());
  const fields: Record<string, string> = {};
  const filesByField = new Map<string, BunUploadedFile[]>();
  let totalFiles = 0;

  // Form order, so the *first* offending part is the one reported — which is
  // what Multer's stream-order check reports too.
  for (const [key, value] of fd.entries()) {
    if (typeof value === 'string') {
      fields[key] = value;
    } else if (isFileEntry(value)) {
      // Is this part acceptable at all? Checked before the global count,
      // because it is about this part rather than the request as a whole.
      const accepted = filesByField.get(key);
      if (
        (policy.field !== null && key !== policy.field) ||
        (accepted?.length ?? 0) >= policy.maxCount
      ) {
        throw new BadRequestException(MULTER_MESSAGES.unexpectedField(key));
      }
      totalFiles++;
      if (limits?.files !== undefined && totalFiles > limits.files) {
        throw new BadRequestException(MULTER_MESSAGES.fileCount);
      }
      const file = await fileFromFormDataEntry(key, value);
      if (limits?.fileSize !== undefined && file.size > limits.fileSize) {
        throw new PayloadTooLargeException(MULTER_MESSAGES.fileSize);
      }
      if (accepted) accepted.push(file);
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
 * Exactly one file, under exactly this field: a file under any other name, or a
 * second one under this one, is a `400 Unexpected field - <name>`. Text fields
 * are not policed by name. A request with no file at all is fine —
 * `req.file` is simply `undefined`.
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
      return from(readFormData(req, { field: fieldName, maxCount: 1 }, options)).pipe(
        switchMap(({ fields, filesByField }) => {
          req.body = { ...(req.body ?? {}), ...fields };
          req.file = filesByField.get(fieldName)?.[0];
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
 * Multi-file upload interceptor. Sets `req.files` to the files uploaded under
 * `fieldName`. A file under any other field, or one past the optional
 * `maxCount`, is a `400 Unexpected field - <name>`, the way Multer answers it.
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
      const policy: FieldPolicy = {
        field: fieldName,
        maxCount: maxCount ?? Number.POSITIVE_INFINITY,
      };
      return from(readFormData(req, policy, options)).pipe(
        switchMap(({ fields, filesByField }) => {
          req.body = { ...(req.body ?? {}), ...fields };
          req.files = filesByField.get(fieldName) ?? [];
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
 * Reads any number of files across any number of fields — the one interceptor
 * that accepts every field name. Sets `req.files` to the flattened list.
 */
export function BunAnyFilesInterceptor(
  options?: BunMultipartOptions,
): Type<NestInterceptor> {
  @Injectable()
  class MixinInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
      const req = context.switchToHttp().getRequest<MultipartRequest>();
      const policy: FieldPolicy = { field: null, maxCount: Number.POSITIVE_INFINITY };
      return from(readFormData(req, policy, options)).pipe(
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
