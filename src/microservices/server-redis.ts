import {
  type CustomTransportStrategy,
  RedisContext,
  Server,
  Transport,
  type WritePacket,
} from '@nestjs/microservices';
import type { RedisClient } from 'bun';
import { BunRedisOptions, NO_MESSAGE_HANDLER, resolveRedisUrl } from './types';

/** Incoming wire packet shape (post-deserialize). */
interface IncomingPacket {
  pattern: unknown;
  data: unknown;
  id?: string;
}

/**
 * @publicApi
 *
 * Native Bun Redis transport strategy for `@nestjs/microservices`, built on
 * `Bun.RedisClient` Pub/Sub instead of `ioredis`. Uses Nest's channel scheme —
 * the (normalized) pattern is the request channel and `<pattern>.reply` carries
 * the response — so it interoperates with Nest's stock `ServerRedis` /
 * `ClientRedis` and with {@link BunClientRedis}.
 *
 * Two connections are used because a Redis client in subscribe mode may only
 * (un)subscribe/ping: `subClient` listens, `pubClient` publishes replies.
 *
 * Usage:
 *   ```ts
 *   const app = await NestFactory.createMicroservice<MicroserviceOptions>(
 *     AppModule,
 *     { strategy: new BunServerRedis({ host: 'localhost', port: 6379 }) },
 *   );
 *   await app.listen();
 *   ```
 */
export class BunServerRedis extends Server implements CustomTransportStrategy {
  public transportId = Transport.REDIS;
  private subClient: RedisClient | null = null;
  private pubClient: RedisClient | null = null;
  private closing = false;

  constructor(private readonly options: BunRedisOptions = {}) {
    super();
    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  async listen(callback: (err?: unknown, ...optionalParams: unknown[]) => void) {
    try {
      const url = resolveRedisUrl(this.options);
      this.pubClient = new Bun.RedisClient(url);
      this.subClient = new Bun.RedisClient(url);
      const onClose = (err: unknown) => {
        if (!this.closing) this.handleError((err as Error)?.message);
      };
      this.pubClient.onclose = onClose;
      this.subClient.onclose = onClose;
      await Promise.all([this.pubClient.connect(), this.subClient.connect()]);

      // Subscribe to every registered pattern channel (messages + events both
      // arrive on the bare pattern; the `id` presence distinguishes them).
      const patterns = [...this.messageHandlers.keys()];
      await Promise.all(
        patterns.map(pattern =>
          this.subClient!.subscribe(pattern, (message, channel) =>
            this.handleMessage(message, channel),
          ),
        ),
      );
      callback();
    } catch (err) {
      callback(err);
    }
  }

  async close() {
    this.closing = true;
    await this.subClient?.close?.();
    await this.pubClient?.close?.();
    this.subClient = null;
    this.pubClient = null;
  }

  unwrap<T>(): T {
    if (!this.pubClient || !this.subClient) {
      throw new Error('Not initialized. Call "listen()" before "unwrap()".');
    }
    return [this.pubClient, this.subClient] as unknown as T;
  }

  on(event: string, callback: Function): void {
    // Bun.RedisClient exposes lifecycle via onconnect/onclose, not an emitter;
    // bridge the common 'error' event to the close hook.
    if (event === 'error' && this.subClient) {
      this.subClient.onclose = err => (callback as (e: unknown) => void)(err);
    }
  }

  private async handleMessage(raw: string, channel: string) {
    const rawMessage = parseJson(raw);
    const packet = (await this.deserializer.deserialize(rawMessage, {
      channel,
    })) as IncomingPacket;
    const context = new RedisContext([channel]);

    if (packet.id === undefined) {
      await this.handleEvent(channel, packet, context);
      return;
    }

    const messageId = packet.id;
    const replyChannel = `${channel}.reply`;
    const publish = (response: WritePacket & { id?: string }) => {
      const outgoing = this.serializer.serialize({ ...response, id: messageId });
      this.onProcessingEndHook?.(this.transportId, context);
      return this.pubClient?.publish(replyChannel, JSON.stringify(outgoing));
    };

    const handler = this.getHandlerByPattern(channel);
    if (!handler) {
      publish({ status: 'error', err: NO_MESSAGE_HANDLER } as WritePacket);
      return;
    }

    return this.onProcessingStartHook(this.transportId, context, async () => {
      const response$ = this.transformToObservable(await handler(packet.data, context));
      this.send(response$, publish);
    });
  }
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}
