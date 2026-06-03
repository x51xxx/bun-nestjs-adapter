# Streaming & Server-Sent Events

## StreamableFile and Node `Readable`

Return a Nest `StreamableFile` or a bare Node `Readable` from a handler and the
adapter converts it to a Web `ReadableStream` and pipes it through `Bun.serve`.

```ts
import { Controller, Get, StreamableFile } from '@nestjs/common';
import { createReadStream } from 'node:fs';

@Controller('files')
export class FilesController {
  @Get('report')
  download() {
    return new StreamableFile(createReadStream('./report.pdf'), {
      type: 'application/pdf',
      disposition: 'attachment; filename="report.pdf"',
    });
  }
}
```

`StreamableFile` headers (`type`, `disposition`, `length`) are applied to the
response unless you've already set them. A bare `Readable` defaults to
`application/octet-stream`.

## Server-Sent Events

`@Sse()` works unchanged. The response carries a Node-`Writable` shim and the
request bridges Bun's `AbortSignal` to a `'close'` event, so Nest core's
`RouterResponseController.sse()` drives it exactly as on Express.

```ts
import { Controller, Sse, MessageEvent } from '@nestjs/common';
import { interval, map, Observable } from 'rxjs';

@Controller('events')
export class EventsController {
  @Sse('stream')
  stream(): Observable<MessageEvent> {
    return interval(1000).pipe(map(n => ({ data: { tick: n } })));
  }
}
```

The client disconnecting fires `req.on('close', …)`, so RxJS subscriptions are
torn down when the browser closes the `EventSource`.

## How buffering becomes streaming

A normal handler return is **buffered** and resolved into a single Web
`Response`. The response only switches to a live `ReadableStream` the first time
something calls `res.write()` / `res.writeHead()` (which is what `StreamableFile`,
`Readable` piping, and SSE all do internally). Until then there's no streaming
overhead. See [Architecture](./architecture.md) for the response model.

Next: [File uploads →](./file-uploads.md)
