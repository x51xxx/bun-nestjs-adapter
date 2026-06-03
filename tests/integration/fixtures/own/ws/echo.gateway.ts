import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WsException,
} from '@nestjs/websockets';
import { throwError } from 'rxjs';

@WebSocketGateway(8765)
export class EchoGateway {
  @SubscribeMessage('push')
  onPush(@MessageBody() data: any) {
    return { event: 'pop', data };
  }

  @SubscribeMessage('reverse')
  onReverse(_client: any, data: { value: string }) {
    return {
      event: 'reverse-result',
      data: { value: data.value.split('').reverse().join('') },
    };
  }

  @SubscribeMessage('boom')
  onBoom() {
    return throwError(() => new WsException('expected ws error'));
  }
}
