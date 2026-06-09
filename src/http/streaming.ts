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

export function nodeReadableToWeb(nodeStream: Readable): ReadableStream {
  return new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk: Uint8Array | string) => {
        controller.enqueue(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk));
      });
      nodeStream.once('end', () => controller.close());
      nodeStream.once('error', (err: Error) => controller.error(err));
    },
    cancel() {
      nodeStream.destroy?.();
    },
  });
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
  response.body = webStream;
  response.finished = true;
  response.headersSent = true;
  response._resolve(
    new Response(webStream, toResponseInit(response.headers, response.statusCode)),
  );
}
