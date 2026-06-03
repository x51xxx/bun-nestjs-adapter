import { NestFactory } from '@nestjs/core';
import { BunHttpAdapter } from '../../../src';
import { applyValidation } from './graphql/bootstrap';
import { YogaAppModule } from './graphql/modules/app-yoga.module';

const port = Number(process.env.PORT) || 3000;
// bodyParser: false — Yoga reads the raw request body itself; the adapter must
// not consume it first (see BunYogaDriver).
NestFactory.create(YogaAppModule, new BunHttpAdapter(), {
  logger: false,
  bodyParser: false,
})
  .then(async app => {
    applyValidation(app);
    await app.listen(port);
  })
  .catch(err => {
    console.error('graphql-nest-bun-yoga start error:', err?.stack || err);
    process.exit(1);
  });
