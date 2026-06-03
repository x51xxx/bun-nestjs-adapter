import { SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';

@WebSocketGateway(8766, { path: '/path-b' })
export class PathBGateway {
  @SubscribeMessage('ping')
  onPing(_c: any, data: any) {
    return { event: 'pong-b', data };
  }
}
