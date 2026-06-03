import { Module } from '@nestjs/common';
import { CaslModule } from '@trishchuk/nest-casl';
import { Roles, todoItemPermissions } from '../graphql/permissions/todo-item.permissions';
import { TodoItemService } from '../graphql/services/todo-item.service';
import { TodoItemRestController } from './todo-item.controller';

@Module({
  imports: [CaslModule.forFeature({ permissions: todoItemPermissions })],
  controllers: [TodoItemRestController],
  providers: [TodoItemService],
})
export class TodoItemRestModule {}

@Module({
  imports: [
    CaslModule.forRoot<Roles>({
      superuserRole: Roles.admin,
      getUserFromRequest: () => ({ id: 1, roles: [Roles.user] }) as unknown as any,
    }),
    TodoItemRestModule,
  ],
})
export class RestAppModule {}
