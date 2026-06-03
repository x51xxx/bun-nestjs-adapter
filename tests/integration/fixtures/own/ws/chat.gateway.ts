import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';

@WebSocketGateway(8767, { path: '/chat' })
export class ChatGateway {
  @WebSocketServer()
  server: any;

  @SubscribeMessage('join')
  onJoin(
    @ConnectedSocket() client: any,
    @MessageBody() data: { room: string },
  ) {
    client.subscribe(data.room);
    return { event: 'joined', data: { room: data.room } };
  }

  @SubscribeMessage('leave')
  onLeave(
    @ConnectedSocket() client: any,
    @MessageBody() data: { room: string },
  ) {
    client.unsubscribe(data.room);
    return { event: 'left', data: { room: data.room } };
  }

  @SubscribeMessage('broadcast')
  onBroadcast(
    @ConnectedSocket() client: any,
    @MessageBody() data: { room: string; text: string },
  ) {
    // client.publish(...) sends to topic subscribers EXCEPT the publisher.
    const delivered = client.publish(
      data.room,
      JSON.stringify({ event: 'message', data: { text: data.text } }),
    );
    return { event: 'sent', data: { room: data.room, delivered } };
  }
}
