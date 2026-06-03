import { NestFactory } from '@nestjs/core';
import { BunHttpAdapter } from '../../../src';
import { applyValidation } from './graphql/bootstrap';
import { AppModule } from './graphql/modules/app.module';

const port = Number(process.env.PORT) || 3000;
NestFactory.create(AppModule, new BunHttpAdapter(), { logger: false })
  .then(async app => {
    applyValidation(app);
    await app.listen(port);
  })
  .catch(err => {
    console.error('graphql-nest-bun start error:', err?.stack || err);
    process.exit(1);
  });
