import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';

export function applyValidation(app: INestApplication) {
  // `transform: true` runs class-transformer so the resolver receives typed
  // instances and class-validator decorators run. `whitelist: true` strips
  // nested object fields when @nestjs/graphql passes inputs through its own
  // args pipeline (the nested classes' validator metadata isn't seen) — so
  // we leave it off and trust the GraphQL schema for shape enforcement.
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
    }),
  );
}
