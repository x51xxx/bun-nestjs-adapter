import { NestFactory } from '@nestjs/core';
import { BunHttpAdapter } from '../../../src';
import { AppModule } from './nest/app.module';

NestFactory.create(AppModule, new BunHttpAdapter(), {
  logger: false,
  bodyParser: false,
})
  .then(app => app.listen(3000))
  .catch(err => {
    console.error('nest-bun start error:', err);
    process.exit(1);
  });
