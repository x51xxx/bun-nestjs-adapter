import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { CaslModule } from '@trishchuk/nest-casl';
import { Roles } from '../permissions/todo-item.permissions';
import { TodoItemModule } from './todo-item.module';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      path: '/graphql',
    }),
    CaslModule.forRoot<Roles>({
      superuserRole: Roles.admin,
      getUserFromRequest: () => ({ id: 1, roles: [Roles.user] }) as unknown as any,
    }),
    TodoItemModule,
  ],
})
export class AppModule {}
