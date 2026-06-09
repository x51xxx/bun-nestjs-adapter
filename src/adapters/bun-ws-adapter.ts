import { EventEmitter } from 'events';
import { Logger } from '@nestjs/common';
import { AbstractWsAdapter } from '@nestjs/websockets';
import { MessageMappingProperties } from '@nestjs/websockets/gateway-metadata-explorer';
import type { ServerWebSocket, WebSocketHandler } from 'bun';
import { EMPTY, Observable, fromEvent } from 'rxjs';
import { filter, first, mergeMap, share, takeUntil } from 'rxjs/operators';
import { BunServer, WsUpgradeData } from '../http/types';

const CLOSE_EVENT = 'close';
const ERROR_EVENT = 'error';

enum READY_STATE {
  CONNECTING = 0,
  OPEN = 1,
  CLOSING = 2,
  CLOSED = 3,
}

type WsMessageData = string | Buffer | ArrayBuffer | Buffer[];
type WsMessageParser = (data: WsMessageData) => { event: string; data: unknown } | void;
type BunWsAdapterOptions = {
  messageParser?: WsMessageParser;
};

interface ServerEntry {
  port: number;
  bunServer: BunServer | null;
  serverEmitter: BunWsServer;
  paths: Map<string, BunWsServer>;
}

/**
 * The duck-typed surface of BunHttpAdapter the WS adapter relies on. Kept
 * structural — importing the class would invert the allowed dependency
 * direction (http must stay loadable without @nestjs/websockets).
 */
interface BunHttpAdapterLike {
  getType(): string;
  getHttpServer():
    | {
        address(): { port: number; address: string; family: string } | string | null;
        bunServer: BunServer | null;
      }
    | undefined;
  wsPaths: Map<string, BunWsServer>;
}

// Widen `on` to a `Function` callback so the classes satisfy AbstractWsAdapter's
// `BaseWsInstance` generic constraint — EventEmitter's listener type is stricter
// under strictFunctionTypes. Runtime behaviour is plain EventEmitter.on.
export interface BunWsClient {
  on(event: string | symbol, listener: Function): this;
}
export interface BunWsServer {
  on(event: string | symbol, listener: Function): this;
}

/**
 * Wrapper over a Bun ServerWebSocket that exposes a Node `ws`-like
 * EventEmitter interface so that AbstractWsAdapter / RxJS bindings work.
 */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: merged interface only widens `on` overloads; it adds no fields needing initialisation
export class BunWsClient extends EventEmitter {
  public readyState: READY_STATE = READY_STATE.CONNECTING;
  public pattern?: string;

  /** Bound by the server's `open` callback once the handshake completes. */
  constructor(public bunWs: ServerWebSocket<WsUpgradeData> | null) {
    super();
  }

  send(data: string | Uint8Array | ArrayBuffer) {
    if (this.readyState !== READY_STATE.OPEN) return;
    this.bunWs?.send(data as string | Uint8Array);
  }

  /** Subscribe this socket to a Bun pub/sub topic. */
  subscribe(topic: string) {
    this.bunWs?.subscribe(topic);
  }
  /** Remove this socket from a topic. */
  unsubscribe(topic: string) {
    this.bunWs?.unsubscribe(topic);
  }
  isSubscribed(topic: string): boolean {
    return !!this.bunWs?.isSubscribed(topic);
  }
  /**
   * Publish to a topic excluding this socket (Bun's per-client publish).
   * Returns the number of messages actually sent.
   */
  publish(topic: string, data: string | Uint8Array): number {
    return this.bunWs?.publish(topic, data) ?? 0;
  }

  close(code?: number, reason?: string) {
    if (this.readyState === READY_STATE.CLOSED || this.readyState === READY_STATE.CLOSING)
      return;
    this.readyState = READY_STATE.CLOSING;
    this.bunWs?.close(code ?? 1000, reason);
  }

  __markOpen() {
    this.readyState = READY_STATE.OPEN;
    this.emit('open');
  }
  __onMessage(data: string | Buffer) {
    this.emit('message', data);
  }
  __onClose(code?: number, reason?: string) {
    this.readyState = READY_STATE.CLOSED;
    this.emit('close', code, reason);
  }
  __onError(err: unknown) {
    this.emit('error', err);
  }
}

/**
 * EventEmitter-style wrapper around a Bun.serve instance bound to a path.
 * Emits 'connection' / 'error' / 'close' so AbstractWsAdapter contract holds.
 */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: merged interface only widens `on` overloads; it adds no fields needing initialisation
export class BunWsServer extends EventEmitter {
  public path: string;
  public clients: Set<BunWsClient> = new Set();
  /** Reference to the underlying Bun.serve instance — exposes pub/sub. */
  public bunServer: BunServer | null = null;
  /** Constructor used by the shared-port HTTP dispatcher to mint clients. */
  public readonly clientClass = BunWsClient;

  constructor(path: string) {
    super();
    this.path = path;
  }

  /**
   * Native Bun.serve pub/sub: send `data` to every WebSocket subscribed to
   * the given topic. See https://bun.com/docs/runtime/http/websockets#pub-sub
   */
  publish(topic: string, data: string | Uint8Array): number {
    if (!this.bunServer) return 0;
    return this.bunServer.publish(topic, data);
  }

  close(cb?: (err?: unknown) => void) {
    for (const client of this.clients) {
      try {
        client.close();
      } catch {}
    }
    this.clients.clear();
    if (cb) cb();
  }
}

// Standalone-port handlers — the shared-port equivalents live in http/server.ts
// (kept separate so the HTTP path never imports this module).
const STANDALONE_WEBSOCKET_HANDLERS: WebSocketHandler<WsUpgradeData> = {
  open: ws => {
    const { client, server } = ws.data;
    if (!client || !server) return;
    // Bind real Bun ws now that handshake completed.
    client.bunWs = ws;
    server.clients.add(client);
    client.__markOpen();
    server.emit('connection', client, undefined);
  },
  message: (ws, message) => {
    ws.data.client?.__onMessage(message);
  },
  close: (ws, code, reason) => {
    const { client, server } = ws.data;
    if (!client) return;
    server?.clients.delete(client);
    client.__onClose(code, reason);
  },
  drain: () => {},
};

/**
 * @publicApi
 */
export class BunWsAdapter extends AbstractWsAdapter<BunWsServer, BunWsClient> {
  private readonly logger = new Logger(BunWsAdapter.name);
  private readonly servers = new Map<number, ServerEntry>();
  private messageParser: WsMessageParser = (data: WsMessageData) =>
    JSON.parse(data.toString());

  constructor(appOrHttpServer?: object, options?: BunWsAdapterOptions) {
    super(appOrHttpServer);
    if (options?.messageParser) this.messageParser = options.messageParser;
  }

  public setMessageParser(parser: WsMessageParser) {
    this.messageParser = parser;
  }

  /**
   * Walk the Nest app / raw server reference handed to the constructor down
   * to a BunHttpAdapter, or null when running on a different platform.
   */
  private resolveBunHttpAdapter(): BunHttpAdapterLike | null {
    const httpServer: {
      adapter?: unknown;
      getHttpAdapter?: () => unknown;
      getUnderlyingHttpAdapter?: () => unknown;
    } | null = this.httpServer;
    if (!httpServer) return null;

    let candidate: unknown = httpServer;
    if (httpServer.adapter) {
      candidate = httpServer.adapter;
    } else if (typeof httpServer.getHttpAdapter === 'function') {
      candidate = httpServer.getHttpAdapter();
    } else if (typeof httpServer.getUnderlyingHttpAdapter === 'function') {
      candidate = httpServer.getUnderlyingHttpAdapter();
    }

    const adapter = candidate as Partial<BunHttpAdapterLike> | null;
    if (adapter && typeof adapter.getType === 'function' && adapter.getType() === 'bun') {
      return adapter as BunHttpAdapterLike;
    }
    return null;
  }

  public create(
    port: number,
    options?: { path?: string; namespace?: string } & Record<string, unknown>,
  ): BunWsServer {
    if (options?.namespace) {
      throw new Error(
        '"BunWsAdapter" does not support namespaces. Use socket.io for that.',
      );
    }

    const httpAdapter = this.resolveBunHttpAdapter();

    const path = normalizePath(options?.path ?? '/');
    const boundAddress = httpAdapter?.getHttpServer()?.address();
    const boundPort =
      typeof boundAddress === 'object' && boundAddress !== null
        ? boundAddress.port
        : undefined;
    const isShared = !port || port === 0 || (httpAdapter !== null && boundPort === port);

    if (isShared) {
      if (!httpAdapter) {
        throw new Error(
          'BunWsAdapter requires a BunHttpAdapter when sharing the underlying HTTP port.',
        );
      }
      let server = httpAdapter.wsPaths.get(path);
      if (!server) {
        server = new BunWsServer(path);
        const nativeServer = httpAdapter.getHttpServer()?.bunServer;
        if (nativeServer) {
          server.bunServer = nativeServer;
        }
        httpAdapter.wsPaths.set(path, server);
      }
      return server;
    }

    let entry = this.servers.get(port);
    if (!entry) {
      entry = this.startBunServer(port);
      this.servers.set(port, entry);
    }

    const existing = entry.paths.get(path);
    if (existing) {
      // Multiple gateways on same port+path: return existing.
      return existing;
    }
    const server = new BunWsServer(path);
    server.bunServer = entry.bunServer;
    entry.paths.set(path, server);
    return server;
  }

  private startBunServer(port: number): ServerEntry {
    if (typeof Bun === 'undefined' || typeof Bun.serve !== 'function') {
      throw new Error('Bun runtime not detected. BunWsAdapter requires the Bun runtime.');
    }
    const entry: ServerEntry = {
      port,
      bunServer: null,
      serverEmitter: new BunWsServer('*'),
      paths: new Map(),
    };

    const config = {
      port,
      fetch: (req: Request, server: BunServer): Response | undefined => {
        const url = new URL(req.url);
        const path = normalizePath(url.pathname);
        const target = entry.paths.get(path);
        if (!target) {
          return new Response('Not Found', { status: 404 });
        }
        const client = new BunWsClient(null);
        client.pattern = path;
        const upgraded = server.upgrade(req, {
          data: { client, server: target },
        });
        if (upgraded) return undefined;
        return new Response('Upgrade required', { status: 426 });
      },
      websocket: STANDALONE_WEBSOCKET_HANDLERS,
    };
    // Same boundary cast as BunHttpServer.listen — Bun.serve's overloads
    // don't accept a structurally-built config object.
    entry.bunServer = Bun.serve(
      config as unknown as Parameters<typeof Bun.serve>[0],
    ) as unknown as BunServer;

    return entry;
  }

  public bindClientConnect(server: BunWsServer, callback: Function) {
    server.on('connection', callback as (...args: unknown[]) => void);
  }

  public bindClientDisconnect(client: BunWsClient, callback: Function) {
    client.on(CLOSE_EVENT, callback as (...args: unknown[]) => void);
  }

  public bindMessageHandlers(
    client: BunWsClient,
    handlers: MessageMappingProperties[],
    transform: (data: unknown) => Observable<unknown>,
  ) {
    const handlersMap = new Map<string, MessageMappingProperties>();
    handlers.forEach(h => handlersMap.set(h.message, h));

    const close$ = fromEvent(client, CLOSE_EVENT).pipe(share(), first());
    const source$ = fromEvent(client, 'message').pipe(
      mergeMap(data =>
        this.bindMessageHandler(data as WsMessageData, handlersMap, transform).pipe(
          filter(result => result !== null && result !== undefined),
        ),
      ),
      takeUntil(close$),
    );
    const onMessage = (response: unknown) => {
      if (client.readyState !== READY_STATE.OPEN) return;
      client.send(JSON.stringify(response));
    };
    source$.subscribe(onMessage);
  }

  private bindMessageHandler(
    buffer: WsMessageData,
    handlersMap: Map<string, MessageMappingProperties>,
    transform: (data: unknown) => Observable<unknown>,
  ): Observable<unknown> {
    try {
      const parsed = this.messageParser(buffer);
      if (!parsed) return EMPTY;
      const handler = handlersMap.get(parsed.event);
      if (!handler) return EMPTY;
      return transform(handler.callback(parsed.data));
    } catch (e) {
      this.logger.error(e);
      return EMPTY;
    }
  }

  public bindErrorHandler(server: BunWsServer) {
    server.on(ERROR_EVENT, (err: unknown) => this.logger.error(err));
    return server;
  }

  public async close(_server: BunWsServer): Promise<void> {
    // No-op per-server: actual shutdown happens in dispose().
  }

  public async dispose(): Promise<void> {
    for (const entry of this.servers.values()) {
      try {
        for (const server of entry.paths.values()) server.close();
        entry.bunServer?.stop();
      } catch (e) {
        this.logger.error(e);
      }
    }
    this.servers.clear();

    const httpAdapter = this.resolveBunHttpAdapter();
    if (httpAdapter?.wsPaths) {
      for (const server of httpAdapter.wsPaths.values()) {
        try {
          server.close();
        } catch {}
      }
      httpAdapter.wsPaths.clear();
    }
  }
}

function normalizePath(path: string | undefined): string {
  if (!path) return '/';
  if (!path.startsWith('/')) path = '/' + path;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}
