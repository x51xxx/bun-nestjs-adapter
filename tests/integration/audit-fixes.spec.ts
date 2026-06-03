/**
 * Regression tests for the audit fixes:
 *
 *   * High #1 — multipart uploads survive the fallback fetch dispatcher
 *     (i.e. when CORS / static / middleware are configured and Bun.serve
 *     native routes are disabled).
 *   * Medium #4 — CORS origin handling: `true`, function, RegExp, array,
 *     credentials echo, exposedHeaders, maxAge.
 *   * Low/Medium #5 — static prefix is boundary-aware (`/static-admin` ≠
 *     `/static`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  Body,
  Controller,
  Get,
  Module,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import {
  BunAnyFilesInterceptor,
  BunFileInterceptor,
  BunHttpAdapter,
  type BunUploadedFile,
  BunWsAdapter,
} from '../../src';

// ───── audit fix #1 — multipart through fallback dispatcher ─────────────────
@Controller('uploads-fallback')
class FallbackUploadsController {
  @Post('single')
  @UseInterceptors(BunFileInterceptor('avatar'))
  upload(@UploadedFile() file: BunUploadedFile, @Body() body: Record<string, string>) {
    return {
      file: file
        ? {
            name: file.originalname,
            size: file.size,
            content: file.buffer.toString('utf8'),
          }
        : null,
      body,
    };
  }
}
@Module({ controllers: [FallbackUploadsController] })
class FallbackUploadsModule {}

describe('audit fix #1 — multipart survives fallback fetch dispatcher', () => {
  let app: any;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FallbackUploadsModule],
    }).compile();
    app = moduleRef.createNestApplication(new BunHttpAdapter(), {
      logger: false,
    });
    // Forcing CORS on disables the Bun.serve({ routes }) fast path so the
    // request must travel through handle() → toBunRequest. That used to
    // call raw.arrayBuffer() before the interceptor could read formData().
    app.enableCors({ origin: '*' });
    await app.init();
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => app.close());

  it('reads the file + extra fields without "Body already used"', async () => {
    const fd = new FormData();
    fd.append('username', 'taras');
    fd.append('avatar', new File(['fallback-bytes'], 'a.txt', { type: 'text/plain' }));
    const res = await fetch(`${baseUrl}/uploads-fallback/single`, {
      method: 'POST',
      body: fd,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.body).toEqual({ username: 'taras' });
    expect(json.file?.name).toBe('a.txt');
    expect(json.file?.size).toBe(14);
    expect(json.file?.content).toBe('fallback-bytes');
  });
});

// ───── shared minimal app for CORS + static specs ───────────────────────────
@Controller()
class HelloController {
  @Get()
  hello() {
    return 'hi';
  }
}
@Module({ controllers: [HelloController] })
class HelloModule {}

async function bootCors(corsOptions: any) {
  const moduleRef = await Test.createTestingModule({
    imports: [HelloModule],
  }).compile();
  const app = moduleRef.createNestApplication(new BunHttpAdapter(), {
    logger: false,
  });
  app.enableCors(corsOptions);
  await app.init();
  await app.listen(0, '127.0.0.1');
  const addr = app.getHttpServer().address();
  return { app, baseUrl: `http://127.0.0.1:${addr.port}` };
}

// ───── audit fix #4 — CORS origin variants ──────────────────────────────────
describe('audit fix #4 — CORS origin variants', () => {
  it('origin: true echoes Origin and sets Vary', async () => {
    const ctx = await bootCors({ origin: true });
    try {
      const res = await fetch(`${ctx.baseUrl}/`, {
        headers: { Origin: 'https://app.example.com' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBe(
        'https://app.example.com',
      );
      expect(res.headers.get('vary')).toContain('Origin');
    } finally {
      await ctx.app.close();
    }
  });

  it('origin: "*" + credentials: true echoes Origin (browser rejects "*")', async () => {
    const ctx = await bootCors({ origin: '*', credentials: true });
    try {
      const res = await fetch(`${ctx.baseUrl}/`, {
        headers: { Origin: 'https://safe.example.com' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBe(
        'https://safe.example.com',
      );
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    } finally {
      await ctx.app.close();
    }
  });

  it('origin: function — return value is honored', async () => {
    const ctx = await bootCors({
      origin: (req: any) =>
        req.headers['origin']?.endsWith('.example.com')
          ? req.headers['origin']
          : 'denied',
    });
    try {
      const allowed = await fetch(`${ctx.baseUrl}/`, {
        headers: { Origin: 'https://api.example.com' },
      });
      expect(allowed.headers.get('access-control-allow-origin')).toBe(
        'https://api.example.com',
      );

      const denied = await fetch(`${ctx.baseUrl}/`, {
        headers: { Origin: 'https://attacker.test' },
      });
      expect(denied.headers.get('access-control-allow-origin')).toBe('denied');
    } finally {
      await ctx.app.close();
    }
  });

  it('origin: array — only echoes whitelisted origins', async () => {
    const ctx = await bootCors({
      origin: ['https://allowed.com', /\.trusted\.test$/],
    });
    try {
      const exact = await fetch(`${ctx.baseUrl}/`, {
        headers: { Origin: 'https://allowed.com' },
      });
      expect(exact.headers.get('access-control-allow-origin')).toBe(
        'https://allowed.com',
      );

      const regex = await fetch(`${ctx.baseUrl}/`, {
        headers: { Origin: 'https://api.trusted.test' },
      });
      expect(regex.headers.get('access-control-allow-origin')).toBe(
        'https://api.trusted.test',
      );

      const blocked = await fetch(`${ctx.baseUrl}/`, {
        headers: { Origin: 'https://nope.com' },
      });
      expect(blocked.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await ctx.app.close();
    }
  });

  it('exposedHeaders + maxAge are emitted', async () => {
    const ctx = await bootCors({
      origin: 'https://x.com',
      exposedHeaders: ['X-Total-Count'],
      maxAge: 600,
    });
    try {
      const res = await fetch(`${ctx.baseUrl}/`);
      expect(res.headers.get('access-control-expose-headers')).toBe('X-Total-Count');
      expect(res.headers.get('access-control-max-age')).toBe('600');
    } finally {
      await ctx.app.close();
    }
  });
});

// ───── audit fix #5 — static prefix boundary ────────────────────────────────
describe('audit fix #5 — static prefix is boundary-aware', () => {
  let app: any;
  let baseUrl: string;
  const root = join(import.meta.dir, 'fixtures', 'own', 'static');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [HelloModule],
    }).compile();
    app = moduleRef.createNestApplication(new BunHttpAdapter(), {
      logger: false,
    });
    app.useStaticAssets(root, { prefix: '/static' });
    await app.init();
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => app.close());

  it('serves /static/index.html', async () => {
    const res = await fetch(`${baseUrl}/static/index.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Hello from static');
  });

  it('does NOT match /static-admin/foo (prefix collision)', async () => {
    const res = await fetch(`${baseUrl}/static-admin/foo`);
    expect(res.status).toBe(404);
    // JSON 404 from the route dispatcher, not the static handler.
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('exact /static/ still resolves to the index file', async () => {
    const res = await fetch(`${baseUrl}/static/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});

// ───── dynamic route reloading ──────────────────────────────────────────────
describe('dynamic route reloading', () => {
  it('rebuilds and reloads native routes dynamically', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [HelloModule],
    }).compile();
    const app = moduleRef.createNestApplication(new BunHttpAdapter(), {
      logger: false,
    });
    await app.init();
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address();
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // Dynamic route registered after listen
      app.getHttpAdapter().get('/lazy-route', (_req: any, res: any) => {
        res.send('lazy-works');
      });

      const res = await fetch(`${baseUrl}/lazy-route`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('lazy-works');
    } finally {
      await app.close();
    }
  });
});

// ───── multipart safety limits ──────────────────────────────────────────────
@Controller('uploads-limits')
class UploadsLimitsController {
  @Post('file-size')
  @UseInterceptors(BunFileInterceptor('avatar', { limits: { fileSize: 10 } }))
  uploadSize(@UploadedFile() file: any) {
    return { size: file?.size };
  }

  @Post('files-count')
  @UseInterceptors(BunAnyFilesInterceptor({ limits: { files: 1 } }))
  uploadCount() {
    return { success: true };
  }
}
@Module({ controllers: [UploadsLimitsController] })
class UploadsLimitsModule {}

describe('multipart safety limits', () => {
  let app: any;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [UploadsLimitsModule],
    }).compile();
    app = moduleRef.createNestApplication(new BunHttpAdapter(), {
      logger: false,
    });
    await app.init();
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => app.close());

  it('allows file within size limits', async () => {
    const fd = new FormData();
    fd.append('avatar', new File(['abc'], 'a.txt'));
    const res = await fetch(`${baseUrl}/uploads-limits/file-size`, {
      method: 'POST',
      body: fd,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.size).toBe(3);
  });

  it('throws 413 Payload Too Large when file size limit exceeded', async () => {
    const fd = new FormData();
    fd.append('avatar', new File(['this-is-too-long-bytes'], 'a.txt'));
    const res = await fetch(`${baseUrl}/uploads-limits/file-size`, {
      method: 'POST',
      body: fd,
    });
    expect(res.status).toBe(413);
  });

  it('throws 400 Bad Request when files count limit exceeded', async () => {
    const fd = new FormData();
    fd.append('f1', new File(['a'], 'a.txt'));
    fd.append('f2', new File(['b'], 'b.txt'));
    const res = await fetch(`${baseUrl}/uploads-limits/files-count`, {
      method: 'POST',
      body: fd,
    });
    expect(res.status).toBe(400);
  });
});

// ───── shared port websockets ───────────────────────────────────────────────
@WebSocketGateway({ path: '/ws-shared' })
class SharedWsGateway {
  @WebSocketServer()
  server: any;

  @SubscribeMessage('ping')
  handlePing(@MessageBody() data: any) {
    return { event: 'pong', data };
  }
}
@Module({ providers: [SharedWsGateway] })
class SharedWsModule {}

describe('shared port websockets', () => {
  function openSocket(url: string) {
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(ws), { once: true });
      ws.addEventListener('error', reject as any, { once: true });
    });
  }

  function getNextMessage(ws: WebSocket): Promise<any> {
    return new Promise(resolve => {
      ws.addEventListener(
        'message',
        ev => resolve(JSON.parse((ev as MessageEvent).data as string)),
        { once: true },
      );
    });
  }

  it('connects and communicates over shared HTTP/WS port', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SharedWsModule],
    }).compile();
    const app = moduleRef.createNestApplication(new BunHttpAdapter(), {
      logger: false,
    });
    app.useWebSocketAdapter(new BunWsAdapter(app));
    await app.init();
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address();
    const wsUrl = `ws://127.0.0.1:${addr.port}/ws-shared`;

    try {
      const ws = await openSocket(wsUrl);
      ws.send(JSON.stringify({ event: 'ping', data: 'hello' }));
      const msg = await getNextMessage(ws);
      expect(msg).toEqual({ event: 'pong', data: 'hello' });
      ws.close();
    } finally {
      await app.close();
    }
  });
});
