import { NestFactory } from '@nestjs/core';
import { BunHttpAdapter } from '../../../src';
import { applyValidation } from './graphql/bootstrap';
import { RestAppModule } from './rest/app.module';

const port = Number(process.env.PORT) || 3000;
NestFactory.create(RestAppModule, new BunHttpAdapter(), { logger: false })
  .then(async app => {
    applyValidation(app);
    await app.listen(port);
  })
  .catch(err => {
    console.error('rest-nest-bun start error:', err?.stack || err);
    process.exit(1);
  });
