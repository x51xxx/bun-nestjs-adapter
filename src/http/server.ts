import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import type { ServerWebSocket, WebSocketHandler } from 'bun';
import { BunServer, WsUpgradeData } from './types';

/**
 * TLS options forwarded verbatim to `Bun.serve({ tls })`. Mirrors Bun's
 * `TLSOptions` so Node-style `httpsOptions` pass through without loss —
 * including mTLS (`requestCert`/`rejectUnauthorized`) and TLS hardening
 * (`secureOptions`, `ciphers`, ALPN). Fields Bun doesn't implement are
 * ignored by the runtime.
 */
export interface BunTlsOptions {
  key?: string | Buffer | Array<string | Buffer>;
  cert?: string | Buffer | Array<string | Buffer>;
  ca?: string | Buffer | Array<string | Buffer>;
  passphrase?: string;
  dhParamsFile?: string;
  serverName?: string;
  lowMemoryMode?: boolean;
  requestCert?: boolean;
  rejectUnauthorized?: boolean;
  secureOptions?: number;
  ALPNProtocols?: string | Uint8Array;
  ciphers?: string;
}

/**
 * A native `Bun.serve({ routes })` handler. Returning `undefined` makes Bun
 * fall through to the `fetch` callback (used for WS upgrades and 404s).
 */
export type BunNativeRouteHandler = (
  req: Request,
) => Response | undefined | Promise<Response | undefined>;

/** `path → handler` or `path → { METHOD: handler }` map for `Bun.serve({ routes })`. */
export type BunNativeRoutes = Record<
  string,
  BunNativeRouteHandler | Record<string, BunNativeRouteHandler>
>;

type FetchHandler = (req: Request, server?: BunServer) => Promise<Response> | Response;

interface BunServeConfig {
  fetch: FetchHandler;
  websocket: WebSocketHandler<WsUpgradeData>;
  error: (err: Error) => Response;
  port?: number;
  hostname?: string;
  unix?: string;
  routes?: BunNativeRoutes;
  tls?: BunTlsOptions;
}

function getBunServe(): typeof Bun.serve | undefined {
  return typeof Bun === 'undefined' ? undefined : Bun.serve;
}

export class BunHttpServer extends EventEmitter {
  public listening = false;
  /** Underlying Bun.serve instance — read by BunWsAdapter for pub/sub. */
  public bunServer: BunServer | null = null;
  private boundPort = 0;
  private boundHost = '127.0.0.1';
  private boundUnixPath: string | null = null;
  /** Optional native Bun routes config built by the adapter at listen-time. */
  public routes: BunNativeRoutes | undefined = undefined;
  /** Optional TLS config (from Nest's `httpsOptions`) applied at listen-time. */
  public tls: BunTlsOptions | undefined = undefined;

  constructor(private readonly fetchHandler: FetchHandler) {
    super();
  }

  listen(
    port: number | string,
    hostnameOrCb?: string | ((err?: Error) => void),
    maybeCb?: (err?: Error) => void,
  ) {
    const hostname = typeof hostnameOrCb === 'string' ? hostnameOrCb : '0.0.0.0';
    const cb = typeof hostnameOrCb === 'function' ? hostnameOrCb : maybeCb;
    try {
      const serveFn = getBunServe();
      if (!serveFn) {
        const err = new Error(
          'Bun runtime not detected. platform-bun requires the Bun runtime.',
        );
        this.emit('error', err);
        cb?.call(this, err);
        return this;
      }
      const isUnixSocket =
        typeof port === 'string' && (port.includes('/') || port.endsWith('.sock'));

      const config: BunServeConfig = {
        fetch: this.fetchHandler,
        websocket: {
          open: (ws: ServerWebSocket<WsUpgradeData>) => {
            const client = ws.data?.client;
            const server = ws.data?.server;
            if (client && server) {
              client.bunWs = ws;
              server.clients.add(client);
              client.__markOpen();
              server.emit('connection', client, undefined);
            }
          },
          message: (ws: ServerWebSocket<WsUpgradeData>, message: string | Buffer) => {
            ws.data?.client?.__onMessage(message);
          },
          close: (ws: ServerWebSocket<WsUpgradeData>, code: number, reason: string) => {
            const client = ws.data?.client;
            const server = ws.data?.server;
            if (client) {
              server?.clients.delete(client);
              client.__onClose(code, reason);
            }
          },
          drain: () => {},
        },
        error: (err: Error) => {
          this.emit('error', err);
          return new Response('Internal Server Error', { status: 500 });
        },
      };

      if (isUnixSocket) {
        config.unix = port as string;
        this.boundUnixPath = port as string;
      } else {
        config.port = Number(port);
        config.hostname = hostname;
      }

      if (this.routes) config.routes = this.routes;
      if (this.tls) config.tls = this.tls;
      // Single boundary cast: Bun.serve's overloads model unix/port variants
      // as separate option types, which a progressively-built config can't
      // satisfy statically.
      this.bunServer = serveFn(
        config as Parameters<typeof Bun.serve>[0],
      ) as unknown as BunServer;
      if (!isUnixSocket) {
        this.boundPort = this.bunServer.port ?? 0;
        this.boundHost = this.bunServer.hostname || hostname;
      }
      this.listening = true;
      cb?.call(this);
      this.emit('listening');
    } catch (err) {
      this.emit('error', err);
      cb?.call(this, err as Error);
    }
    return this;
  }

  /**
   * Swap the native route table on a live server (`undefined` clears it,
   * forcing every request through the `fetch` dispatcher). Encapsulates the
   * boundary cast — `Server.reload` is typed against full serve options.
   */
  applyRoutes(routes: BunNativeRoutes | undefined) {
    this.routes = routes;
    this.bunServer?.reload({
      routes: routes ?? {},
    } as unknown as Parameters<BunServer['reload']>[0]);
  }

  address() {
    if (!this.listening) return null;
    if (this.boundUnixPath) {
      return this.boundUnixPath;
    }
    return {
      port: this.boundPort,
      address: this.boundHost,
      family: this.boundHost.includes(':') ? 'IPv6' : 'IPv4',
    };
  }

  close(cb?: (err?: Error) => void) {
    const done = (err?: Error) => {
      this.listening = false;
      this.emit('close');
      cb?.(err);
    };

    try {
      this.bunServer?.stop();
      if (this.boundUnixPath) {
        fs.unlink(this.boundUnixPath)
          .then(() => done())
          // The socket file already being gone (e.g. removed by Bun on stop,
          // or never created) is a successful teardown, not an error.
          .catch((err: NodeJS.ErrnoException) =>
            done(err?.code === 'ENOENT' ? undefined : err),
          );
      } else {
        done();
      }
    } catch (err) {
      done(err as Error);
    }
    return this;
  }
}
