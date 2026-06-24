import { Logger } from '@nestjs/common';
import { ClientProxy, type ReadPacket, type WritePacket } from '@nestjs/microservices';
import type { RedisClient } from 'bun';
import { BunRedisOptions, resolveRedisUrl } from './types';

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
 * Native Bun Redis client proxy for `@nestjs/microservices`, built on
 * `Bun.RedisClient` Pub/Sub. Wire-compatible with Nest's `ServerRedis` and with
 * {@link BunServerRedis}: a request is published to the pattern channel and the
 * reply is read from `<pattern>.reply`.
 *
 *   ```ts
 *   const client = new BunClientRedis({ host: 'localhost', port: 6379 });
 *   const result = await firstValueFrom(client.send('sum', [1, 2, 3]));
 *   ```
 */
export class BunClientRedis extends ClientProxy {
  protected readonly logger = new Logger(BunClientRedis.name);
  private pubClient: RedisClient | null = null;
  private subClient: RedisClient | null = null;
  private connectionPromise: Promise<unknown> | null = null;
  private closing = false;
  // Active reply-channel subscriptions, ref-counted so concurrent requests on
  // the same pattern share one subscription.
  private readonly subscriptions = new Map<string, number>();

  constructor(private readonly options: BunRedisOptions = {}) {
    super();
    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  connect(): Promise<unknown> {
    if (this.connectionPromise) return this.connectionPromise;
    const url = resolveRedisUrl(this.options);
    this.pubClient = new Bun.RedisClient(url);
    this.subClient = new Bun.RedisClient(url);
    this.pubClient.onclose = err => this.handleError(err);
    this.subClient.onclose = err => this.handleError(err);
    this.connectionPromise = Promise.all([
      this.pubClient.connect(),
      this.subClient.connect(),
    ]);
    return this.connectionPromise;
  }

  async close() {
    this.closing = true;
    await this.subClient?.close?.();
    await this.pubClient?.close?.();
    this.pubClient = null;
    this.subClient = null;
    this.connectionPromise = null;
    this.subscriptions.clear();
  }

  unwrap<T>(): T {
    if (!this.pubClient || !this.subClient) {
      throw new Error('Not initialized. Call the "connect()" method first.');
    }
    return [this.pubClient, this.subClient] as unknown as T;
  }

  protected publish(
    partialPacket: ReadPacket,
    callback: (packet: WritePacket) => void,
  ): () => void {
    try {
      const packet = this.assignPacketId(partialPacket);
      const pattern = this.normalizePattern(partialPacket.pattern);
      const serialized = this.serializer.serialize(packet);
      const replyChannel = `${pattern}.reply`;

      const sendRequest = () => {
        this.routingMap.set(packet.id, callback);
        this.pubClient?.publish(pattern, JSON.stringify(serialized));
      };

      const count = this.subscriptions.get(replyChannel) ?? 0;
      this.subscriptions.set(replyChannel, count + 1);
      if (count <= 0) {
        // First waiter on this reply channel — subscribe, then publish.
        this.subClient
          ?.subscribe(replyChannel, message => this.handleResponse(message))
          .then(sendRequest)
          .catch(err => callback({ err }));
      } else {
        sendRequest();
      }

      return () => {
        this.routingMap.delete(packet.id);
        const remaining = (this.subscriptions.get(replyChannel) ?? 1) - 1;
        this.subscriptions.set(replyChannel, remaining);
        if (remaining <= 0) {
          this.subscriptions.delete(replyChannel);
          this.subClient?.unsubscribe(replyChannel).catch(() => {});
        }
      };
    } catch (err) {
      callback({ err });
      return () => {};
    }
  }

  protected async dispatchEvent<T = unknown>(packet: ReadPacket): Promise<T> {
    const pattern = this.normalizePattern(packet.pattern);
    const serialized = this.serializer.serialize({ ...packet, pattern });
    await this.pubClient?.publish(pattern, JSON.stringify(serialized));
    return undefined as T;
  }

  private async handleResponse(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    const { err, response, isDisposed, id } = (await this.deserializer.deserialize(
      parsed,
    )) as ResponsePacket;
    const callback = id !== undefined ? this.routingMap.get(id) : undefined;
    if (!callback) return;
    if (isDisposed || err) {
      callback({ err, response, isDisposed: true });
      return;
    }
    callback({ err, response });
  }

  private handleError(err: unknown): void {
    if (err && !this.closing) this.logger.error(err);
  }
}
