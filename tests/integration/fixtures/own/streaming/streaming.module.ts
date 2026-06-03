import { Module } from '@nestjs/common';
import { StreamingController } from './streaming.controller';

@Module({ controllers: [StreamingController] })
export class StreamingModule {}
