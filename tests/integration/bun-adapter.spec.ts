import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { BunHttpAdapter } from '../../src';
import { AppModule } from './fixtures/own/app.module';

describe('platform-bun adapter', () => {
  let app: any;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, new BunHttpAdapter(), {
      logger: false,
    });
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /cats returns json list', async () => {
    const res = await fetch(`${baseUrl}/cats`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toEqual([
      { id: 1, name: 'Whiskers', age: 3 },
      { id: 2, name: 'Mittens', age: 5 },
    ]);
  });

  it('GET /cats?limit=1 honors query params', async () => {
    const res = await fetch(`${baseUrl}/cats?limit=1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([{ id: 1, name: 'Whiskers', age: 3 }]);
  });

  it('GET /cats/:id resolves route params', async () => {
    const res = await fetch(`${baseUrl}/cats/2`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: 2, name: 'Mittens', age: 5 });
  });

  it('GET /cats/echo-headers attaches @Header decorator value', async () => {
    const res = await fetch(`${baseUrl}/cats/echo-headers`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-custom')).toBe('bun-adapter');
  });

  it('POST /cats accepts JSON body and respects @HttpCode(201)', async () => {
    const res = await fetch(`${baseUrl}/cats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Tom', age: 7 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe('Tom');
    expect(body.age).toBe(7);
    expect(typeof body.id).toBe('number');
  });

  it('PUT /cats/:id replaces entry', async () => {
    const res = await fetch(`${baseUrl}/cats/1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Whiskers II', age: 4 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: 1, name: 'Whiskers II', age: 4 });
  });

  it('DELETE /cats/:id returns 204 with empty body', async () => {
    const res = await fetch(`${baseUrl}/cats/2`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    const text = await res.text();
    expect(text).toBe('');
  });

  it('GET /cats/redirect/legacy returns 302 redirect', async () => {
    const res = await fetch(`${baseUrl}/cats/redirect/legacy`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/cats');
  });

  it('unknown route returns 404 from adapter default handler', async () => {
    const res = await fetch(`${baseUrl}/missing`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.statusCode).toBe(404);
  });

  it('adapter exposes its type', async () => {
    expect(app.getHttpAdapter().getType()).toBe('bun');
  });
});
