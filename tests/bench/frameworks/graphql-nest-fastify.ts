import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { applyValidation } from './graphql/bootstrap';
import { AppModule } from './graphql/modules/app.module';

const port = Number(process.env.PORT) || 3000;
NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
  logger: false,
})
  .then(async app => {
    applyValidation(app);
    await app.listen(port);
  })
  .catch(err => {
    console.error('graphql-nest-fastify start error:', err?.stack || err);
    process.exit(1);
  });
