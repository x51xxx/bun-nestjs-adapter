import { Body, Controller, Get, Post } from '@nestjs/common';

interface EchoBody {
  ping: string;
  count: number;
  tags: string[];
  meta: Record<string, string>;
}

const SAMPLE_JSON = {
  id: 1,
  name: 'Benchmark',
  tags: ['fast', 'native', 'bun'],
  scores: [99, 100, 98, 97, 96],
  meta: {
    created: '2025-01-01T00:00:00Z',
    region: 'eu-central-1',
    version: '1.0.0',
  },
  items: Array.from({ length: 10 }, (_, i) => ({
    id: i + 1,
    label: `item-${i + 1}`,
    enabled: i % 2 === 0,
  })),
};

@Controller('/')
export class AppController {
  @Get()
  root() {
    return 'Hello world!';
  }

  // Exercises the Response.json fast path. Same payload every time so
  // numbers reflect serialiser cost, not allocator noise.
  @Get('json')
  json() {
    return SAMPLE_JSON;
  }

  // Exercises both Request.json (parse) and Response.json (encode).
  @Post('echo')
  echo(@Body() body: EchoBody) {
    return {
      received: body,
      sizeOfTags: body?.tags?.length ?? 0,
      reversedPing: body?.ping?.split('').reverse().join('') ?? '',
    };
  }
}
