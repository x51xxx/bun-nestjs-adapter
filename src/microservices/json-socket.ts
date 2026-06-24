import { EventEmitter } from 'events';
import type { Socket } from 'bun';

/**
 * Default cap mirrors Nest's `JsonSocket` — 512 MB expressed in characters
 * (4 bytes per character on a 32-bit string heap).
 */
const DEFAULT_MAX_BUFFER_SIZE = (512 * 1024 * 1024) / 4;

export interface BunJsonSocketOptions {
  maxBufferSize?: number;
}

/**
 * Length-prefixed JSON framing over a Bun TCP `Socket`, wire-compatible with
 * `@nestjs/microservices`' `JsonSocket`. The frame format is
 * `<charLength>#<json>` where `charLength` is the JS string length of the
 * serialised JSON (UTF-16 code units, NOT bytes) and `#` is the delimiter.
 *
 * Receiving uses a streaming `TextDecoder` so a multibyte UTF-8 sequence split
 * across two TCP reads is reassembled before the character-length comparison —
 * the same guarantee Node's `StringDecoder` gives Nest's implementation.
 *
 * Emits:
 *  - `'message'` with the parsed JSON object (already `JSON.parse`d, matching
 *    Nest's `TcpSocket.emitMessage`).
 *  - `'error'` with an `Error` on malformed framing / JSON.
 *  - `'close'` once the underlying socket is gone.
 */
export class BunJsonSocket extends EventEmitter {
  public isClosed = false;
  private contentLength: number | null = null;
  private buffer = '';
  private readonly decoder = new TextDecoder('utf-8');
  private readonly delimiter = '#';
  private readonly maxBufferSize: number;
  // Bytes that could not be flushed because of socket backpressure; drained
  // FIFO in `onDrain()`.
  private readonly pending: Uint8Array[] = [];

  constructor(
    // Socket data shape varies per caller (server vs client); the framing
    // layer is agnostic to it, so `any` keeps it decoupled.
    public socket: Socket<any> | null,
    options?: BunJsonSocketOptions,
  ) {
    super();
    this.maxBufferSize = options?.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
  }

  /** Serialise + frame + write a message, honouring socket backpressure. */
  send(message: unknown): void {
    const json = JSON.stringify(message);
    const framed = `${json.length}${this.delimiter}${json}`;
    this.write(new TextEncoder().encode(framed));
  }

  private write(bytes: Uint8Array): void {
    if (this.isClosed || !this.socket) return;
    if (this.pending.length > 0) {
      this.pending.push(bytes);
      return;
    }
    const written = this.socket.write(bytes);
    if (written < bytes.length) {
      this.pending.push(bytes.subarray(written));
    }
  }

  /** Flush queued bytes when Bun signals the socket is writable again. */
  onDrain(): void {
    if (!this.socket) return;
    while (this.pending.length > 0) {
      const head = this.pending[0];
      const written = this.socket.write(head);
      if (written < head.length) {
        this.pending[0] = head.subarray(written);
        return;
      }
      this.pending.shift();
    }
  }

  /** Feed raw bytes from Bun's `data` callback into the framing state machine. */
  onData(chunk: Uint8Array): void {
    try {
      this.buffer += this.decoder.decode(chunk, { stream: true });
      this.drainBuffer();
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      this.end();
    }
  }

  // Iterative (not recursive) frame extraction — pipelined small frames in one
  // read must not grow the stack. Mirrors JsonSocket.handleData.
  private drainBuffer(): void {
    while (true) {
      if (this.buffer.length > this.maxBufferSize) {
        const len = this.buffer.length;
        this.buffer = '';
        throw new Error(`Max packet length exceeded: ${len}`);
      }
      if (this.contentLength === null) {
        const i = this.buffer.indexOf(this.delimiter);
        // Delimiter not yet received — the length prefix may be mid-arrival.
        if (i === -1) return;
        const rawLen = this.buffer.substring(0, i);
        const parsed = Number.parseInt(rawLen, 10);
        if (Number.isNaN(parsed)) {
          this.buffer = '';
          throw new Error(`Corrupted packet length: ${rawLen}`);
        }
        this.contentLength = parsed;
        this.buffer = this.buffer.substring(i + 1);
      }
      const length = this.buffer.length;
      if (length === this.contentLength) {
        const message = this.buffer;
        this.contentLength = null;
        this.buffer = '';
        this.emitMessage(message);
      } else if (length > this.contentLength) {
        const message = this.buffer.substring(0, this.contentLength);
        const rest = this.buffer.substring(this.contentLength);
        this.contentLength = null;
        this.buffer = rest;
        this.emitMessage(message);
      } else {
        // Incomplete payload — wait for the next chunk.
        return;
      }
    }
  }

  private emitMessage(data: string): void {
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch (err) {
      throw new Error(
        `Invalid JSON format: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.emit('message', message ?? {});
  }

  /** Mark closed and notify listeners (idempotent). */
  handleClose(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.emit('close');
  }

  end(): void {
    try {
      this.socket?.end();
    } catch {
      // Socket already torn down — nothing to flush.
    }
  }
}
