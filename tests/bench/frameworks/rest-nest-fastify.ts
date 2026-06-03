import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { applyValidation } from './graphql/bootstrap';
import { RestAppModule } from './rest/app.module';

const port = Number(process.env.PORT) || 3000;
NestFactory.create<NestFastifyApplication>(RestAppModule, new FastifyAdapter(), {
  logger: false,
})
  .then(async app => {
    applyValidation(app);
    await app.listen(port);
  })
  .catch(err => {
    console.error('rest-nest-fastify start error:', err?.stack || err);
    process.exit(1);
  });
