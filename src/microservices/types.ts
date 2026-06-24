import type { Deserializer, Serializer } from '@nestjs/microservices';
import type { TLSOptions } from 'bun';

/**
 * Mirrors `@nestjs/microservices`' public constant — the error string a server
 * returns when no `@MessagePattern` handler matches an incoming request. Kept
 * inline so the value travels in the bundle without a deep-path import.
 */
export const NO_MESSAGE_HANDLER =
  'There is no matching message handler defined in the remote service.';

/**
 * Options for the native Bun TCP transport ({@link BunServerTcp} /
 * {@link BunClientTcp}). A subset of Nest's `TcpOptions['options']` plus a
 * Bun-native `tls` passthrough (forwarded verbatim to `Bun.listen`/`Bun.connect`).
 */
export interface BunTcpOptions {
  host?: string;
  port?: number;
  /** Max framing buffer in characters before a connection is torn down. */
  maxBufferSize?: number;
  /** Client-only: reconnection attempts after a dropped connection. */
  retryAttempts?: number;
  /** Client-only: delay in ms between reconnection attempts. */
  retryDelay?: number;
  serializer?: Serializer;
  deserializer?: Deserializer;
  /** Forwarded to `Bun.listen({ tls })` / `Bun.connect({ tls })`. */
  tls?: TLSOptions;
}

/**
 * Options for the native Bun Redis transport ({@link BunServerRedis} /
 * {@link BunClientRedis}). Built on `Bun.RedisClient` (a.k.a. `Bun.redis`).
 * Uses Nest's Redis Pub/Sub channel scheme (`pattern` request channel,
 * `pattern.reply` response channel), so it interoperates with Nest's stock
 * Redis transport.
 */
export interface BunRedisOptions {
  /** Full connection URL (wins over host/port), e.g. `redis://localhost:6379`. */
  url?: string;
  host?: string;
  port?: number;
  serializer?: Serializer;
  deserializer?: Deserializer;
}

/** Resolve a `redis://` URL from `{ url | host + port }` (defaults to localhost:6379). */
export function resolveRedisUrl(options: BunRedisOptions): string {
  if (options.url) return options.url;
  return `redis://${options.host ?? 'localhost'}:${options.port ?? 6379}`;
}
