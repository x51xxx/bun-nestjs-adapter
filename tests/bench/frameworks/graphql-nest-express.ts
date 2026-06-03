import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { applyValidation } from './graphql/bootstrap';
import { AppModule } from './graphql/modules/app.module';

const port = Number(process.env.PORT) || 3000;
NestFactory.create(AppModule, new ExpressAdapter(), { logger: false })
  .then(async app => {
    applyValidation(app);
    await app.listen(port);
  })
  .catch(err => {
    console.error('graphql-nest-express start error:', err?.stack || err);
    process.exit(1);
  });
