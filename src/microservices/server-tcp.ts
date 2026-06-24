import { EventEmitter } from 'events';
import {
  type CustomTransportStrategy,
  Server,
  TcpContext,
  Transport,
  type WritePacket,
} from '@nestjs/microservices';
import type { Socket, TCPSocketListener } from 'bun';
import { BunJsonSocket } from './json-socket';
import { BunTcpOptions, NO_MESSAGE_HANDLER } from './types';

interface SocketData {
  js: BunJsonSocket;
}

/** Incoming wire packet shape (post-deserialize). */
interface IncomingPacket {
  pattern: unknown;
  data: unknown;
  id?: string;
}

/**
 * @publicApi
 *
 * Native Bun TCP transport strategy for `@nestjs/microservices`, built on
 * `Bun.listen()` instead of `node:net`. Speaks the exact length-prefixed JSON
 * framing (`<charLength>#<json>`) of Nest's built-in TCP transport, so it is
 * wire-compatible with a stock `ClientTCP` (and with {@link BunClientTcp}).
 *
 * Usage:
 *   ```ts
 *   const app = await NestFactory.createMicroservice<MicroserviceOptions>(
 *     AppModule,
 *     { strategy: new BunServerTcp({ host: '0.0.0.0', port: 3001 }) },
 *   );
 *   await app.listen();
 *   ```
 */
export class BunServerTcp extends Server implements CustomTransportStrategy {
  public transportId = Transport.TCP;
  private server: TCPSocketListener<SocketData> | null = null;
  private readonly host: string;
  private readonly port: number;
  private readonly maxBufferSize?: number;
  private readonly events = new EventEmitter();

  constructor(private readonly options: BunTcpOptions = {}) {
    super();
    this.host = this.getOptionsProp(options, 'host', 'localhost');
    this.port = this.getOptionsProp(options, 'port', 3000);
    this.maxBufferSize = this.getOptionsProp(options, 'maxBufferSize');
    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  listen(callback: (err?: unknown, ...optionalParams: unknown[]) => void): void {
    try {
      this.server = Bun.listen<SocketData>({
        hostname: this.host,
        port: this.port,
        tls: this.options.tls,
        socket: {
          open: socket => this.handleOpen(socket),
          data: (socket, data) => socket.data?.js.onData(data),
          close: socket => this.handleSocketClose(socket),
          error: (socket, error) => this.handleSocketError(socket, error),
          drain: socket => socket.data?.js.onDrain(),
        },
      });
      this.events.emit('listening');
      callback();
    } catch (err) {
      callback(err);
    }
  }

  close(): void {
    this.server?.stop(true);
    this.server = null;
  }

  unwrap<T>(): T {
    if (!this.server) {
      throw new Error(
        'Not initialized. Call "listen()"/"startAllMicroservices()" before "unwrap()".',
      );
    }
    return this.server as unknown as T;
  }

  on(event: string, callback: Function): void {
    this.events.on(event, callback as (...args: unknown[]) => void);
  }

  private handleOpen(socket: Socket<SocketData>): void {
    const js = new BunJsonSocket(
      socket,
      this.maxBufferSize !== undefined
        ? { maxBufferSize: this.maxBufferSize }
        : undefined,
    );
    socket.data = { js };
    js.on('message', (msg: IncomingPacket) => this.handleMessage(js, msg));
    js.on('error', err => this.handleError((err as Error).message));
    this.events.emit('connection', js);
  }

  private handleSocketClose(socket: Socket<SocketData>): void {
    socket.data?.js.handleClose();
  }

  private handleSocketError(socket: Socket<SocketData>, error: Error): void {
    socket.data?.js.emit('error', error);
    this.handleError(error.message);
  }

  private async handleMessage(socket: BunJsonSocket, rawMessage: IncomingPacket) {
    const packet = (await this.deserializer.deserialize(rawMessage)) as IncomingPacket;
    const pattern =
      typeof packet.pattern === 'string'
        ? packet.pattern
        : JSON.stringify(packet.pattern);
    const context = new TcpContext([socket as never, pattern]);

    // No `id` → fire-and-forget event (`@EventPattern`), never a reply.
    if (packet.id === undefined) {
      await this.handleEvent(pattern, packet, context);
      return;
    }

    const handler = this.getHandlerByPattern(pattern);
    if (!handler) {
      socket.send(
        this.serializer.serialize({
          id: packet.id,
          status: 'error',
          err: NO_MESSAGE_HANDLER,
        }),
      );
      return;
    }

    const messageId = packet.id;
    const respond = (data: WritePacket) => {
      const outgoing = this.serializer.serialize({ ...data, id: messageId });
      this.onProcessingEndHook?.(this.transportId, context);
      socket.send(outgoing);
    };

    return this.onProcessingStartHook(this.transportId, context, async () => {
      const response$ = this.transformToObservable(await handler(packet.data, context));
      this.send(response$, respond);
    });
  }
}
