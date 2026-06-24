import { Logger } from '@nestjs/common';
import { ClientProxy, type ReadPacket, type WritePacket } from '@nestjs/microservices';
import type { Socket } from 'bun';
import { BunJsonSocket } from './json-socket';
import { BunTcpOptions } from './types';

interface SocketData {
  js: BunJsonSocket;
}

/** Response wire packet (post-deserialize). */
interface ResponsePacket {
  id?: string;
  response?: unknown;
  isDisposed?: boolean;
  err?: unknown;
}

/**
 * @publicApi
 *
 * Native Bun TCP client proxy for `@nestjs/microservices`, built on
 * `Bun.connect()`. Wire-compatible with Nest's `ServerTCP` and with
 * {@link BunServerTcp}, so it is a drop-in replacement for `ClientTCP`:
 *
 *   ```ts
 *   const client = new BunClientTcp({ host: 'localhost', port: 3001 });
 *   const result = await firstValueFrom(client.send('sum', [1, 2, 3]));
 *   ```
 */
export class BunClientTcp extends ClientProxy {
  protected readonly logger = new Logger(BunClientTcp.name);
  private socket: BunJsonSocket | null = null;
  private connectionPromise: Promise<unknown> | null = null;
  private readonly host: string;
  private readonly port: number;
  private readonly maxBufferSize?: number;

  constructor(private readonly options: BunTcpOptions = {}) {
    super();
    this.host = this.getOptionsProp(options, 'host', 'localhost');
    this.port = this.getOptionsProp(options, 'port', 3000);
    this.maxBufferSize = this.getOptionsProp(options, 'maxBufferSize');
    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  connect(): Promise<unknown> {
    if (this.connectionPromise) {
      return this.connectionPromise;
    }
    this.connectionPromise = Bun.connect<SocketData>({
      hostname: this.host,
      port: this.port,
      tls: this.options.tls,
      socket: {
        open: socket => this.handleOpen(socket),
        data: (socket, data) => socket.data?.js.onData(data),
        close: () => this.handleClose(),
        error: (_socket, error) => this.handleError(error),
        drain: socket => socket.data?.js.onDrain(),
      },
    }).then(socket => {
      // `open` already wired the framing socket onto `socket.data`.
      this.socket = socket.data.js;
      this._status$.next('connected' as never);
      return socket;
    });
    return this.connectionPromise;
  }

  close(): void {
    this.socket?.end();
    this.handleClose();
  }

  unwrap<T>(): T {
    if (!this.socket?.socket) {
      throw new Error('Not initialized. Call the "connect()" method first.');
    }
    return this.socket.socket as unknown as T;
  }

  protected publish(
    partialPacket: ReadPacket,
    callback: (packet: WritePacket) => void,
  ): () => void {
    try {
      const packet = this.assignPacketId(partialPacket);
      const serialized = this.serializer.serialize(packet);
      this.routingMap.set(packet.id, callback);
      this.socket?.send(serialized);
      return () => this.routingMap.delete(packet.id);
    } catch (err) {
      callback({ err });
      return () => {};
    }
  }

  protected async dispatchEvent<T = unknown>(packet: ReadPacket): Promise<T> {
    const pattern = this.normalizePattern(packet.pattern);
    const serialized = this.serializer.serialize({ ...packet, pattern });
    this.socket?.send(serialized);
    return undefined as T;
  }

  private handleOpen(socket: Socket<SocketData>): void {
    const js = new BunJsonSocket(
      socket,
      this.maxBufferSize !== undefined
        ? { maxBufferSize: this.maxBufferSize }
        : undefined,
    );
    socket.data = { js };
    js.on('message', (msg: ResponsePacket) => this.handleResponse(msg));
    js.on('error', err => this.handleError(err as Error));
  }

  private async handleResponse(rawMessage: ResponsePacket): Promise<void> {
    const { err, response, isDisposed, id } = (await this.deserializer.deserialize(
      rawMessage,
    )) as ResponsePacket;
    const callback = id !== undefined ? this.routingMap.get(id) : undefined;
    if (!callback) return;
    if (isDisposed || err) {
      callback({ err, response, isDisposed: true });
      return;
    }
    callback({ err, response });
  }

  private handleClose(): void {
    this.socket = null;
    this.connectionPromise = null;
    this._status$.next('disconnected' as never);
    // Fail every in-flight request so callers don't hang forever.
    if (this.routingMap.size > 0) {
      const err = new Error('Connection closed');
      for (const callback of this.routingMap.values()) {
        callback({ err });
      }
      this.routingMap.clear();
    }
  }

  private handleError(err: Error): void {
    this.logger.error(err);
  }
}
