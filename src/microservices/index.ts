/*
 * Native Bun transport for @nestjs/microservices.
 *
 * Exposed as a SEPARATE entry point (`@trishchuk/bun-nestjs-adapter/microservices`)
 * so the optional `@nestjs/microservices` peer dependency is never pulled into
 * the main HTTP/WS bundle — HTTP-only consumers don't pay for it.
 */
export { BunServerTcp } from './server-tcp';
export { BunClientTcp } from './client-tcp';
export { BunServerRedis } from './server-redis';
export { BunClientRedis } from './client-redis';
export { BunJsonSocket } from './json-socket';
export type { BunJsonSocketOptions } from './json-socket';
export { NO_MESSAGE_HANDLER } from './types';
export type { BunTcpOptions, BunRedisOptions } from './types';
