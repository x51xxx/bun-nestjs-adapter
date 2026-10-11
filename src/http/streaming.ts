import { Readable } from 'stream';
import { toResponseInit } from './response';
import { BunResponse } from './types';

/** The duck-typed subset of Nest's `StreamableFile` the adapter relies on. */
export interface StreamableLike {
  getStream(): Readable;
  getHeaders(): { type?: string; disposition?: string; length?: number } | undefined;
}

export function isStreamableFile(value: object): value is StreamableLike {
  // duck-type check — avoids importing the class so we don't pin the import
  // graph and keep the adapter functional even when @nestjs/common doesn't
  // ship the file-stream module yet.
  const candidate = value as Partial<StreamableLike>;
  return (
    typeof candidate.getStream === 'function' &&
    typeof candidate.getHeaders === 'function'
  );
}

export function isNodeReadable(value: object): value is Readable {
  const candidate = value as Partial<Readable>;
  return typeof candidate.pipe === 'function' && typeof candidate.read === 'function';
}

/**
 * Fallback for when `Readable.toWeb` is unavailable or throws. Flow-controlled
 * like it: the source is paused once the queue holds a high-water mark of
 * bytes and resumed from `pull()`, so a slow client doesn't make the whole
 * source pile up in memory.
 */
export function nodeReadableToWeb(nodeStream: Readable): ReadableStream {
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        nodeStream.on('data', (chunk: Uint8Array | string) => {
          controller.enqueue(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk));
          if ((controller.desiredSize ?? 1) <= 0) nodeStream.pause();
        });
        nodeStream.once('end', () => controller.close());
        nodeStream.once('error', (err: Error) => controller.error(err));
      },
      pull() {
        nodeStream.resume();
      },
      cancel() {
        nodeStream.destroy?.();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }),
  );
}

/**
 * Resolve the response with a Node `Readable` converted to a web stream.
 * Prefer Node's own `Readable.toWeb` — it handles backpressure and pauses
 * the source until pull, so no data is lost. The old `globalThis.require`
 * lookup was unreliable in Bun's ESM context (undefined on Linux), which
 * silently dropped us into the racy manual wrapper and produced empty/500
 * streamed responses there — hence the static-import detection.
 */
export function streamNodeReadable(response: BunResponse, nodeStream: Readable): void {
  let webStream: ReadableStream;
  if (typeof Readable.toWeb === 'function') {
    try {
      webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;
    } catch {
      webStream = nodeReadableToWeb(nodeStream);
    }
  } else {
    webStream = nodeReadableToWeb(nodeStream);
  }
  // Same idle-timer opt-out the writable shim performs on `write()`: a Node
  // stream can sit quiet between chunks (a slow producer, a throttled file),
  // and Bun's default 10 s idleTimeout would cut the response mid-body.
  response._disableIdleTimeout?.();
  response.body = webStream;
  response.finished = true;
  response.headersSent = true;
  response._resolve(
    new Response(webStream, toResponseInit(response.headers, response.statusCode)),
  );
}
