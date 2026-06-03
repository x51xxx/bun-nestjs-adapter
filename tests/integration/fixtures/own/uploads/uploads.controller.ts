import {
  Body,
  Controller,
  Post,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import {
  BunAnyFilesInterceptor,
  BunFileInterceptor,
  BunFilesInterceptor,
  type BunUploadedFile,
} from '../../../../../src';

@Controller('uploads')
export class UploadsController {
  @Post('single')
  @UseInterceptors(BunFileInterceptor('avatar'))
  single(
    @UploadedFile() file: BunUploadedFile,
    @Body() body: Record<string, string>,
  ) {
    return {
      file: file
        ? {
            fieldname: file.fieldname,
            originalname: file.originalname,
            mimetype: file.mimetype,
            size: file.size,
            content: file.buffer.toString('utf8'),
          }
        : null,
      body,
    };
  }

  @Post('multi')
  @UseInterceptors(BunFilesInterceptor('docs', 3))
  multi(@UploadedFiles() files: BunUploadedFile[]) {
    return {
      count: files.length,
      files: files.map(f => ({
        name: f.originalname,
        size: f.size,
        content: f.buffer.toString('utf8'),
      })),
    };
  }

  @Post('any')
  @UseInterceptors(BunAnyFilesInterceptor())
  any(@UploadedFiles() files: BunUploadedFile[]) {
    return {
      total: files.length,
      fieldnames: files.map(f => f.fieldname),
    };
  }
}
