import { Controller, Get, Sse, StreamableFile } from '@nestjs/common';
import { Readable } from 'stream';
import { interval, map, take, Observable } from 'rxjs';

@Controller('streaming')
export class StreamingController {
  @Get('streamable-buffer')
  streamableBuffer(): StreamableFile {
    const buf = Buffer.from('hello-from-streamable-file');
    return new StreamableFile(buf, { type: 'text/plain' });
  }

  @Get('streamable-readable')
  streamableReadable(): StreamableFile {
    let i = 0;
    const stream = new Readable({
      read() {
        if (i < 3) {
          this.push(`chunk-${i++};`);
        } else {
          this.push(null);
        }
      },
    });
    return new StreamableFile(stream, { type: 'text/plain' });
  }

  @Get('readable-direct')
  readableDirect(): Readable {
    let i = 0;
    return new Readable({
      read() {
        if (i < 5) this.push(String(i++));
        else this.push(null);
      },
    });
  }

  @Sse('events')
  sse(): Observable<{ data: { tick: number } }> {
    return interval(50).pipe(
      take(3),
      map(tick => ({ data: { tick } })),
    );
  }
}
