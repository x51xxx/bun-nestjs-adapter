import { afterEach, describe, expect, it } from 'bun:test';
import { connect } from 'net';
import { Controller, Get, Module, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BunHttpAdapter } from '../../src';
import type { BunResponse } from '../../src';

// H6 in the 2026-09-06 audit, re-measured on Bun 1.4.2 (see AUDIT.md).
//
// Two facts that look like one, and the audit had them tangled:
//
//   * `res._reject()` on a streaming response DOES abort the transfer — no
//     terminating chunk, the client can tell. That is the H1a fix working.
//   * A handler that throws after `write()` never reaches `_reject`: Nest's
//     exception filter sees `isHeadersSent()` and calls `httpAdapter.end()`,
//     which closes the stream cleanly. @nestjs/platform-express produces
//     byte-identical output, so this is Nest's contract, not a Bun or adapter
//     defect. Pinned here so a future "fix" has to be a deliberate divergence.

let app: { close(): Promise<unknown>; getHttpServer(): any } | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

@Controller()
class StreamController {
  @Get('reject')
  async reject(@Res() res: BunResponse) {
    res.type('text/plain');
    (res as never as { write(c: string): void }).write('A'.repeat(100));
    await Bun.sleep(30);
    res._reject(new Error('exploded'));
  }

  @Get('throw')
  async throwAfterWrite(@Res() res: BunResponse) {
    res.type('text/plain');
    (res as never as { write(c: string): void }).write('partial');
    await Bun.sleep(30);
    throw new Error('exploded');
  }

  @Get('ok')
  async ok(@Res() res: BunResponse) {
    res.type('text/plain');
    (res as never as { write(c: string): void }).write('A'.repeat(100));
    await Bun.sleep(30);
    res.end();
  }
}

@Module({ controllers: [StreamController] })
class StreamModule {}

async function boot(): Promise<number> {
  const created = await NestFactory.create(StreamModule, new BunHttpAdapter(), {
    logger: false,
  });
  await created.listen(0, '127.0.0.1');
  app = created as never;
  return created.getHttpServer().address().port;
}

function raw(port: number, path: string): Promise<{ body: string; hadError: boolean }> {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1', () =>
      socket.write(`GET ${path} HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n`),
    );
    let body = '';
    socket.on('data', d => {
      body += d.toString();
    });
    socket.on('close', (hadError: boolean) => resolve({ body, hadError }));
    socket.on('error', () => resolve({ body, hadError: true }));
  });
}

describe('H6 — a failure mid-stream', () => {
  it('_reject() aborts the transfer without the terminating chunk', async () => {
    const port = await boot();
    const failed = await raw(port, '/reject');
    const succeeded = await raw(port, '/ok');

    expect(succeeded.body.endsWith('0\r\n\r\n')).toBe(true);
    expect(failed.body.endsWith('0\r\n\r\n')).toBe(false);
    expect(failed.hadError).toBe(true);
    expect(failed.body).not.toBe(succeeded.body);
  });

  it('makes a fetch client reject rather than resolve', async () => {
    const port = await boot();
    let threw = false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/reject`);
      await res.text();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('leaves a throw-after-write looking complete, exactly as Express does', async () => {
    // Not a defect: Nest ends an already-headers-sent response rather than
    // aborting it, on every platform. Measured against platform-express —
    // byte-identical, terminating chunk and all.
    const port = await boot();
    const res = await fetch(`http://127.0.0.1:${port}/throw`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('partial');
  });
});
