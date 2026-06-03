import { Module } from '@nestjs/common';
import { CaslModule } from '@trishchuk/nest-casl';
import { todoItemPermissions } from '../permissions/todo-item.permissions';
import { TodoItemResolver } from '../resolvers/todo-item.resolver';
import { TodoItemService } from '../services/todo-item.service';

// The resolver is fully hand-written (queries, mutations, @ResolveField), so
// nestjs-query's auto-CRUD was never used — dropped with the `@ptc-org/*`
// dependency. The DTO now uses plain `@nestjs/graphql` `@Field` decorators.
@Module({
  imports: [CaslModule.forFeature({ permissions: todoItemPermissions })],
  providers: [TodoItemService, TodoItemResolver],
})
export class TodoItemModule {}
