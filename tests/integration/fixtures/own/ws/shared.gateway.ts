import { SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';

/**
 * No explicit port → shared-port mode: the gateway attaches to the main
 * HTTP server and upgrades happen on the app's listen port.
 */
@WebSocketGateway({ path: '/ws-shared' })
export class SharedGateway {
  @SubscribeMessage('ping')
  onPing(_c: any, data: any) {
    return { event: 'pong-shared', data };
  }
}
