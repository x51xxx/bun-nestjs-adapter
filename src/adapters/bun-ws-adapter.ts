import { EventEmitter } from 'events';
import { Logger } from '@nestjs/common';
import { AbstractWsAdapter } from '@nestjs/websockets';
import { MessageMappingProperties } from '@nestjs/websockets/gateway-metadata-explorer';
import { EMPTY, Observable, fromEvent } from 'rxjs';
import { filter, first, mergeMap, share, takeUntil } from 'rxjs/operators';

const CLOSE_EVENT = 'close';
const ERROR_EVENT = 'error';

enum READY_STATE {
  CONNECTING = 0,
  OPEN = 1,
  CLOSING = 2,
  CLOSED = 3,
}

type WsData = string | Buffer | ArrayBuffer | Buffer[];
type WsMessageParser = (data: WsData) => { event: string; data: any } | void;
type BunWsAdapterOptions = {
  messageParser?: WsMessageParser;
};

interface ServerEntry {
  port: number;
  bunServer: any;
  serverEmitter: BunWsServer;
  paths: Map<string, BunWsServer>;
}

/**
 * Wrapper over a Bun ServerWebSocket that exposes a Node `ws`-like
 * EventEmitter interface so that AbstractWsAdapter / RxJS bindings work.
 */
class BunWsClient extends EventEmitter {
  public readyState: READY_STATE = READY_STATE.CONNECTING;
  public pattern?: string;

  constructor(private readonly bunWs: any) {
    super();
  }

  send(data: string | Uint8Array | ArrayBuffer) {
    if (this.readyState !== READY_STATE.OPEN) return;
    this.bunWs.send(data);
  }

  /** Subscribe this socket to a Bun pub/sub topic. */
  subscribe(topic: string) {
    this.bunWs?.subscribe?.(topic);
  }
  /** Remove this socket from a topic. */
  unsubscribe(topic: string) {
    this.bunWs?.unsubscribe?.(topic);
  }
  isSubscribed(topic: string): boolean {
    return !!this.bunWs?.isSubscribed?.(topic);
  }
  /**
   * Publish to a topic excluding this socket (Bun's per-client publish).
   * Returns the number of messages actually sent.
   */
  publish(topic: string, data: string | Uint8Array): number {
    return this.bunWs?.publish?.(topic, data) ?? 0;
  }

  close(code?: number, reason?: string) {
    if (this.readyState === READY_STATE.CLOSED || this.readyState === READY_STATE.CLOSING)
      return;
    this.readyState = READY_STATE.CLOSING;
    this.bunWs.close(code ?? 1000, reason);
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
  __onError(err: any) {
    this.emit('error', err);
  }
}

/**
 * EventEmitter-style wrapper around a Bun.serve instance bound to a path.
 * Emits 'connection' / 'error' / 'close' so AbstractWsAdapter contract holds.
 */
class BunWsServer extends EventEmitter {
  public path: string;
  public clients: Set<BunWsClient> = new Set();
  /** Reference to the underlying Bun.serve instance — exposes pub/sub. */
  public bunServer: any = null;

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

  close(cb?: (err?: any) => void) {
    for (const client of this.clients) {
      try {
        client.close();
      } catch {}
    }
    this.clients.clear();
    if (cb) cb();
  }
}

/**
 * @publicApi
 */
export class BunWsAdapter extends AbstractWsAdapter {
  private readonly logger = new Logger(BunWsAdapter.name);
  private readonly servers = new Map<number, ServerEntry>();
  private messageParser: WsMessageParser = (data: WsData) => JSON.parse(data.toString());

  constructor(appOrHttpServer?: any, options?: BunWsAdapterOptions) {
    super(appOrHttpServer);
    if (options?.messageParser) this.messageParser = options.messageParser;
  }

  public setMessageParser(parser: WsMessageParser) {
    this.messageParser = parser;
  }

  public create(
    port: number,
    options?: Record<string, any> & { path?: string; namespace?: string },
  ): BunWsServer {
    if (options?.namespace) {
      throw new Error(
        '"BunWsAdapter" does not support namespaces. Use socket.io for that.',
      );
    }

    let httpAdapter: any = null;
    if (this.httpServer) {
      if (this.httpServer.adapter) {
        httpAdapter = this.httpServer.adapter;
      } else if (typeof this.httpServer.getHttpAdapter === 'function') {
        httpAdapter = this.httpServer.getHttpAdapter();
      } else if (typeof this.httpServer.getUnderlyingHttpAdapter === 'function') {
        httpAdapter = this.httpServer.getUnderlyingHttpAdapter();
      } else {
        httpAdapter = this.httpServer;
      }
    }
    const isBunHttp = httpAdapter && httpAdapter.getType?.() === 'bun';

    const path = normalizePath(options?.path ?? '/');
    const isShared =
      !port ||
      port === 0 ||
      (isBunHttp && httpAdapter.getHttpServer()?.address()?.port === port);

    if (isShared) {
      if (!isBunHttp) {
        throw new Error(
          'BunWsAdapter requires a BunHttpAdapter when sharing the underlying HTTP port.',
        );
      }
      let server = httpAdapter.wsPaths.get(path);
      if (!server) {
        server = new BunWsServer(path);
        (server as any).clientClass = BunWsClient;
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

    if (entry.paths.has(path)) {
      // Multiple gateways on same port+path: return existing.
      return entry.paths.get(path)!;
    }
    const server = new BunWsServer(path);
    server.bunServer = entry.bunServer;
    entry.paths.set(path, server);
    return server;
  }

  private startBunServer(port: number): ServerEntry {
    const ServeFn = (globalThis as any).Bun?.serve;
    if (!ServeFn) {
      throw new Error('Bun runtime not detected. BunWsAdapter requires the Bun runtime.');
    }
    const entry: ServerEntry = {
      port,
      bunServer: null,
      serverEmitter: new BunWsServer('*'),
      paths: new Map(),
    };

    entry.bunServer = ServeFn({
      port,
      fetch: (req: Request, server: any) => {
        const url = new URL(req.url);
        const path = normalizePath(url.pathname);
        const target = entry.paths.get(path);
        if (!target) {
          return new Response('Not Found', { status: 404 });
        }
        const client = new BunWsClient(null as any);
        client.pattern = path;
        const upgraded = server.upgrade(req, {
          data: { client, server: target },
        });
        if (upgraded) return undefined;
        return new Response('Upgrade required', { status: 426 });
      },
      websocket: {
        open: (ws: any) => {
          const client: BunWsClient = ws.data?.client;
          const server: BunWsServer = ws.data?.server;
          if (!client || !server) return;
          // Bind real Bun ws now that handshake completed.
          (client as any).bunWs = ws;
          server.clients.add(client);
          client.__markOpen();
          server.emit('connection', client, undefined);
        },
        message: (ws: any, message: string | Buffer) => {
          const client: BunWsClient = ws.data?.client;
          if (!client) return;
          client.__onMessage(message);
        },
        close: (ws: any, code: number, reason: string) => {
          const client: BunWsClient = ws.data?.client;
          const server: BunWsServer = ws.data?.server;
          if (!client) return;
          server?.clients.delete(client);
          client.__onClose(code, reason);
        },
        drain: () => {},
      },
    });

    return entry;
  }

  public bindClientConnect(server: BunWsServer, callback: Function) {
    server.on('connection', callback as any);
  }

  public bindClientDisconnect(client: BunWsClient, callback: Function) {
    client.on(CLOSE_EVENT, callback as any);
  }

  public bindMessageHandlers(
    client: BunWsClient,
    handlers: MessageMappingProperties[],
    transform: (data: any) => Observable<any>,
  ) {
    const handlersMap = new Map<string, MessageMappingProperties>();
    handlers.forEach(h => handlersMap.set(h.message, h));

    const close$ = fromEvent(client, CLOSE_EVENT).pipe(share(), first());
    const source$ = fromEvent(client, 'message').pipe(
      mergeMap(data =>
        this.bindMessageHandler(data, handlersMap, transform).pipe(
          filter(result => result !== null && result !== undefined),
        ),
      ),
      takeUntil(close$),
    );
    const onMessage = (response: any) => {
      if (client.readyState !== READY_STATE.OPEN) return;
      client.send(JSON.stringify(response));
    };
    source$.subscribe(onMessage);
  }

  private bindMessageHandler(
    buffer: any,
    handlersMap: Map<string, MessageMappingProperties>,
    transform: (data: any) => Observable<any>,
  ): Observable<any> {
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
    server.on(ERROR_EVENT, (err: any) => this.logger.error(err));
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

    let httpAdapter: any = null;
    if (this.httpServer) {
      if (this.httpServer.adapter) {
        httpAdapter = this.httpServer.adapter;
      } else if (typeof this.httpServer.getHttpAdapter === 'function') {
        httpAdapter = this.httpServer.getHttpAdapter();
      } else if (typeof this.httpServer.getUnderlyingHttpAdapter === 'function') {
        httpAdapter = this.httpServer.getUnderlyingHttpAdapter();
      } else {
        httpAdapter = this.httpServer;
      }
    }
    const isBunHttp = httpAdapter && httpAdapter.getType?.() === 'bun';
    if (isBunHttp && httpAdapter.wsPaths) {
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
