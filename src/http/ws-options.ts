import type { WebSocketHandler } from 'bun';

/**
 * Bun's per-server WebSocket tuning, forwarded to `Bun.serve({ websocket })`.
 * Lives on the HTTP side so both adapters can use it — `bun-http-adapter.ts`
 * must not import `bun-ws-adapter.ts` (optional `@nestjs/websockets` peer).
 *
 * - `perMessageDeflate` — permessage-deflate compression (off by default).
 * - `maxPayloadLength` — largest accepted message; bigger ones close the
 *   socket with 1009. Bun's default is 16 MiB.
 * - `backpressureLimit` / `closeOnBackpressureLimit` — bytes buffered per
 *   socket before `send()` reports backpressure (`-1`), and whether to drop
 *   the socket at that point instead.
 * - `idleTimeout` — seconds without traffic before the socket is closed.
 * - `sendPings` — answer idleness with pings rather than closing.
 * - `publishToSelf` — whether `ws.publish()` also reaches the sender.
 *
 * See https://bun.com/docs/runtime/http/websockets.
 */
export type BunWebSocketOptions = Partial<
  Pick<
    WebSocketHandler<unknown>,
    | 'perMessageDeflate'
    | 'maxPayloadLength'
    | 'backpressureLimit'
    | 'closeOnBackpressureLimit'
    | 'idleTimeout'
    | 'sendPings'
    | 'publishToSelf'
  >
>;

const KEYS = [
  'perMessageDeflate',
  'maxPayloadLength',
  'backpressureLimit',
  'closeOnBackpressureLimit',
  'idleTimeout',
  'sendPings',
  'publishToSelf',
] as const;

/** Copy only the known, defined tuning keys — never the handler callbacks. */
export function pickWebSocketOptions(options?: BunWebSocketOptions): BunWebSocketOptions {
  const out: Record<string, unknown> = {};
  if (!options) return out;
  for (const key of KEYS) {
    if (options[key] !== undefined) out[key] = options[key];
  }
  return out as BunWebSocketOptions;
}
