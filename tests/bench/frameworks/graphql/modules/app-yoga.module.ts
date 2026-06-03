import type { YogaDriverConfig } from '@graphql-yoga/nestjs';
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { CaslModule } from '@trishchuk/nest-casl';
import { BunYogaDriver } from '../bun-yoga-driver';
import { Roles } from '../permissions/todo-item.permissions';
import { TodoItemModule } from './todo-item.module';

/**
 * Same workload as `AppModule` (Apollo), but driven by GraphQL Yoga via the
 * experimental `BunYogaDriver`. Boot the app with `{ bodyParser: false }`.
 */
@Module({
  imports: [
    GraphQLModule.forRoot<YogaDriverConfig>({
      driver: BunYogaDriver,
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
export class YogaAppModule {}
