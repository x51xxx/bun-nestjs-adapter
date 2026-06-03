import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { BunResponse } from '../../../../../src';

interface Cat {
  id: number;
  name: string;
  age: number;
}

@Controller('cats')
export class CatsController {
  private readonly cats: Cat[] = [
    { id: 1, name: 'Whiskers', age: 3 },
    { id: 2, name: 'Mittens', age: 5 },
  ];

  @Get()
  findAll(@Query('limit') limit?: string): Cat[] {
    if (limit) return this.cats.slice(0, Number(limit));
    return this.cats;
  }

  @Get('echo-headers')
  @Header('x-custom', 'bun-adapter')
  echoHeaders() {
    return { ok: true };
  }

  @Get(':id')
  findOne(@Param('id') id: string): Cat | { message: string } {
    const found = this.cats.find(c => c.id === Number(id));
    return found ?? { message: `cat ${id} not found` };
  }

  @Post()
  @HttpCode(201)
  create(@Body() body: Omit<Cat, 'id'>): Cat {
    const next: Cat = { id: this.cats.length + 1, ...body };
    this.cats.push(next);
    return next;
  }

  @Put(':id')
  replace(
    @Param('id') id: string,
    @Body() body: Omit<Cat, 'id'>,
  ): Cat | { message: string } {
    const idx = this.cats.findIndex(c => c.id === Number(id));
    if (idx === -1) return { message: 'not found' };
    this.cats[idx] = { id: Number(id), ...body };
    return this.cats[idx];
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string): void {
    const idx = this.cats.findIndex(c => c.id === Number(id));
    if (idx !== -1) this.cats.splice(idx, 1);
  }

  @Get('redirect/legacy')
  redirect(@Res() res: BunResponse) {
    res.redirect(302, '/cats');
  }
}
