import { SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';

@WebSocketGateway(8766, { path: '/path-a' })
export class PathAGateway {
  @SubscribeMessage('ping')
  onPing(_c: any, data: any) {
    return { event: 'pong-a', data };
  }
}
