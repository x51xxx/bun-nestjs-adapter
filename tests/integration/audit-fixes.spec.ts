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
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  Body,
  Controller,
  Get,
  Module,
  Post,
  Render,
  Req,
  Res,
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

// ───── view engine support ──────────────────────────────────────────────────
@Controller('views')
class ViewsController {
  @Get('ejs')
  @Render('hello')
  renderEjs() {
    return { name: 'EJS World' };
  }

  @Get('pug')
  @Render('hello')
  renderPug() {
    return { name: 'Pug World' };
  }

  @Get('hbs')
  @Render('hello')
  renderHbs() {
    return { name: 'Hbs World' };
  }
}

@Module({ controllers: [ViewsController] })
class ViewsModule {}

describe('view engine support', () => {
  let app: any;
  let baseUrl: string;
  const tempViewsDir = join(import.meta.dir, 'fixtures', 'own', 'temp_views');

  beforeAll(async () => {
    await fs.mkdir(tempViewsDir, { recursive: true });
    await fs.writeFile(join(tempViewsDir, 'hello.ejs'), '<h1>Hello <%= name %></h1>');
    await fs.writeFile(join(tempViewsDir, 'hello.pug'), 'h1 Hello #{name}');
    await fs.writeFile(join(tempViewsDir, 'hello.hbs'), '<h1>Hello {{name}}</h1>');
  });

  afterAll(async () => {
    await fs.rm(tempViewsDir, { recursive: true, force: true });
  });

  const setupApp = async (engine: string) => {
    const moduleRef = await Test.createTestingModule({
      imports: [ViewsModule],
    }).compile();
    const adapter = new BunHttpAdapter();
    adapter.setViewEngine(engine);
    adapter.setBaseViewsDir(tempViewsDir);

    app = moduleRef.createNestApplication(adapter, { logger: false });
    await app.init();
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  };

  it('renders EJS template correctly', async () => {
    await setupApp('ejs');
    try {
      const res = await fetch(`${baseUrl}/views/ejs`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toBe('<h1>Hello EJS World</h1>');
    } finally {
      await app.close();
    }
  });

  it('renders Pug template correctly', async () => {
    await setupApp('pug');
    try {
      const res = await fetch(`${baseUrl}/views/pug`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toBe('<h1>Hello Pug World</h1>');
    } finally {
      await app.close();
    }
  });

  it('renders Handlebars template correctly', async () => {
    await setupApp('hbs');
    try {
      const res = await fetch(`${baseUrl}/views/hbs`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toBe('<h1>Hello Hbs World</h1>');
    } finally {
      await app.close();
    }
  });
});

// ───── cookies support ──────────────────────────────────────────────────────
@Controller('cookies')
class CookiesController {
  @Get('set')
  setCookies(@Res() res: any) {
    res
      .cookie('plain', 'hello', { path: '/' })
      .cookie('signed_cookie', 'secret_val', { signed: true })
      .send('ok');
  }

  @Get('get')
  getCookies(@Req() req: any) {
    return {
      cookies: req.cookies,
      signedCookies: req.signedCookies,
    };
  }

  @Get('clear')
  clearCookies(@Res() res: any) {
    res.clearCookie('plain').send('cleared');
  }

  @Get('set-obj')
  setObjCookie(@Res() res: any) {
    res.cookie('prefs', { theme: 'dark', n: 1 }).send('ok');
  }
}

@Module({ controllers: [CookiesController] })
class CookiesModule {}

describe('cookies support', () => {
  let app: any;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CookiesModule],
    }).compile();
    const adapter = new BunHttpAdapter();
    adapter.enableCookieParser('my-secret-key');
    app = moduleRef.createNestApplication(adapter, { logger: false });
    await app.init();
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('sets cookies (including signed cookies) in response', async () => {
    const res = await fetch(`${baseUrl}/cookies/set`);
    expect(res.status).toBe(200);
    const setCookieHeaders = res.headers.getSetCookie();

    const plainCookie = setCookieHeaders.find(c => c.startsWith('plain='));
    expect(plainCookie).toBeDefined();
    expect(plainCookie).toContain('plain=hello');
    expect(plainCookie).toContain('Path=/');

    const signedCookie = setCookieHeaders.find(c => c.startsWith('signed_cookie='));
    expect(signedCookie).toBeDefined();
    expect(signedCookie).toContain('signed_cookie=s%3Asecret_val.');
  });

  it('parses incoming cookies and signed cookies', async () => {
    const setRes = await fetch(`${baseUrl}/cookies/set`);
    const setCookies = setRes.headers.getSetCookie();
    const cookieHeaderVal = setCookies.map(c => c.split(';')[0]).join('; ');

    const getRes = await fetch(`${baseUrl}/cookies/get`, {
      headers: {
        Cookie: cookieHeaderVal,
      },
    });
    expect(getRes.status).toBe(200);
    const json = await getRes.json();
    expect(json.cookies.plain).toBe('hello');
    expect(json.signedCookies.signed_cookie).toBe('secret_val');
  });

  it('round-trips object cookies via the j: prefix', async () => {
    const setRes = await fetch(`${baseUrl}/cookies/set-obj`);
    const cookieHeaderVal = setRes.headers
      .getSetCookie()
      .map(c => c.split(';')[0])
      .join('; ');

    const getRes = await fetch(`${baseUrl}/cookies/get`, {
      headers: { Cookie: cookieHeaderVal },
    });
    const json = await getRes.json();
    expect(json.cookies.prefs).toEqual({ theme: 'dark', n: 1 });
  });

  it('clears cookies correctly', async () => {
    const res = await fetch(`${baseUrl}/cookies/clear`);
    expect(res.status).toBe(200);
    const setCookies = res.headers.getSetCookie();
    const plainCookie = setCookies.find(c => c.startsWith('plain='));
    expect(plainCookie).toBeDefined();
    expect(plainCookie).toContain('Max-Age=0');
    expect(plainCookie).toContain('Expires=');
  });
});

// ───── unix domain socket binding support ────────────────────────────────────
describe('unix domain socket binding support', () => {
  let app: any;
  const sockPath = join(process.cwd(), 'test-app.sock');

  beforeAll(async () => {
    try {
      await fs.unlink(sockPath);
    } catch {}
  });

  afterAll(async () => {
    try {
      await fs.unlink(sockPath);
    } catch {}
  });

  it('listens and handles requests on a unix domain socket', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [HelloModule],
    }).compile();
    app = moduleRef.createNestApplication(new BunHttpAdapter(), {
      logger: false,
    });
    await app.init();
    await app.listen(sockPath);

    const addr = app.getHttpServer().address();
    expect(addr).toBe(sockPath);

    const res = await fetch('http://localhost/', {
      unix: sockPath,
    } as any);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hi');

    await app.close();

    let fileExists = true;
    try {
      await fs.stat(sockPath);
    } catch {
      fileExists = false;
    }
    expect(fileExists).toBe(false);
  });
});
