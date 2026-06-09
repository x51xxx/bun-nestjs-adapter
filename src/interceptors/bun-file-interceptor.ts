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
 */
export interface BunMultipartOptions {
  limits?: {
    fileSize?: number; // max file size in bytes
    files?: number; // max number of files
  };
}

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

async function readFormData(
  req: MultipartRequest,
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
  const fd: FormData = await source.formData();
  const fields: Record<string, string> = {};
  const filesByField = new Map<string, BunUploadedFile[]>();
  const limits = options?.limits;
  let totalFiles = 0;

  for (const [key, value] of fd.entries()) {
    if (typeof value === 'string') {
      fields[key] = value;
    } else if (isFileEntry(value)) {
      totalFiles++;
      if (limits?.files !== undefined && totalFiles > limits.files) {
        throw new BadRequestException(`Too many files (limit: ${limits.files})`);
      }
      const file = await fileFromFormDataEntry(key, value);
      if (limits?.fileSize !== undefined && file.size > limits.fileSize) {
        throw new PayloadTooLargeException(
          `File size limit exceeded (limit: ${limits.fileSize} bytes)`,
        );
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
      return from(readFormData(req, options)).pipe(
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
 * uploaded under `fieldName`. Optional `maxCount` truncates the array.
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
      return from(readFormData(req, options)).pipe(
        switchMap(({ fields, filesByField }) => {
          req.body = { ...(req.body ?? {}), ...fields };
          const list = filesByField.get(fieldName) ?? [];
          req.files = maxCount ? list.slice(0, maxCount) : list;
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
