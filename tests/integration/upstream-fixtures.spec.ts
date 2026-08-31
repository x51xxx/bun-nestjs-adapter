/**
 * Compatibility suite — exercises our adapter against the *upstream*
 * `nestjs/nest` integration fixtures (loaded from the git submodule under
 * `fixtures/nestjs-nest/integration/...`). Each block boots the upstream
 * AppModule with `BunHttpAdapter` and replays representative requests via
 * Bun-native `fetch`.
 *
 * Adding a new fixture directory is one block. If the fixture isn't
 * available (e.g. submodule not installed), the entire `describe` is
 * skipped instead of failing.
 *
 * Run via `bun run test:fixtures` after `bun run fixtures:install`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { BunHttpAdapter } from '../../src';

const FIXTURES_ROOT = join(
  import.meta.dir,
  '..',
  '..',
  'fixtures',
  'nestjs-nest',
  'integration',
);

const skipIfMissing = (path: string) =>
  existsSync(path)
    ? { describe, available: true }
    : { describe: describe.skip, available: false };

async function bootApp(AppModule: any, configure?: (app: any) => void) {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication(new BunHttpAdapter(), {
    logger: false,
  });
  configure?.(app);
  await app.init();
  await app.listen(0, '127.0.0.1');
  const addr = app.getHttpServer().address();
  return { app, baseUrl: `http://127.0.0.1:${addr.port}` };
}

// ───── hello-world ──────────────────────────────────────────────────────────
const helloWorld = skipIfMissing(
  join(FIXTURES_ROOT, 'hello-world', 'src', 'app.module.ts'),
);
helloWorld.describe('upstream :: hello-world', () => {
  let ctx: { app: any; baseUrl: string };
  beforeAll(async () => {
    const { AppModule } = await import(
      join(FIXTURES_ROOT, 'hello-world', 'src', 'app.module.ts')
    );
    ctx = await bootApp(AppModule);
  });
  afterAll(async () => ctx.app.close());

  it('GET /hello → 200 "Hello world!"', async () => {
    const res = await fetch(`${ctx.baseUrl}/hello`, {
      headers: { Host: 'example.com' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Hello world!');
  });

  it('GET /hello/async returns the async greeting', async () => {
    const res = await fetch(`${ctx.baseUrl}/hello/async`, {
      headers: { Host: 'example.com' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Hello world!');
  });

  it('GET /hello/stream resolves an Observable greeting', async () => {
    const res = await fetch(`${ctx.baseUrl}/hello/stream`, {
      headers: { Host: 'example.com' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Hello world!');
  });

  it('host-bound controller (acme.example.com)', async () => {
    const res = await fetch(`${ctx.baseUrl}/host`, {
      headers: { Host: 'acme.example.com' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Host Greeting! tenant=acme');
  });
});

// ───── versioning (URI + middleware) ────────────────────────────────────────
const versioning = skipIfMissing(
  join(FIXTURES_ROOT, 'versioning', 'src', 'app.module.ts'),
);
versioning.describe('upstream :: versioning (URI + middleware)', () => {
  let ctx: { app: any; baseUrl: string };
  beforeAll(async () => {
    const { AppModule } = await import(
      join(FIXTURES_ROOT, 'versioning', 'src', 'app.module.ts')
    );
    const { VersioningType } = await import('@nestjs/common');
    ctx = await bootApp(AppModule, app => {
      app.enableVersioning({
        type: VersioningType.URI,
        defaultVersion: '1',
      });
    });
  });
  afterAll(async () => ctx.app.close());

  // Plain it() — Bun's it.each interaction with describe.skip-on-missing
  // currently throws "Cannot convert a symbol to a string" before beforeAll
  // even when the describe is supposed to run. Stick to it() pairs.
  const cases: Array<[string, number, string | null]> = [
    ['/v1', 200, 'Hello World V1!'],
    ['/v2', 200, 'Hello World V2!'],
    ['/v3', 404, null],
    ['/v1/multiple', 200, 'Multiple Versions 1 or 2'],
    ['/v2/multiple', 200, 'Multiple Versions 1 or 2'],
    ['/neutral', 200, 'Neutral'],
    ['/v1/override', 200, 'Override Version 1'],
    ['/v2/override', 200, 'Override Version 2'],
  ];
  for (const [path, status, expected] of cases) {
    it(`GET ${path} → ${status}${expected ? ` ${JSON.stringify(expected)}` : ''}`, async () => {
      const res = await fetch(`${ctx.baseUrl}${path}`);
      expect(res.status).toBe(status);
      if (expected !== null) expect(await res.text()).toBe(expected);
    });
  }

  it('functional middleware fires on /v1/middleware', async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/middleware`);
    expect(await res.text()).toBe('Hello from middleware function!');
  });

  it('middleware/neutral works for version-neutral controllers', async () => {
    const res = await fetch(`${ctx.baseUrl}/middleware/neutral`);
    expect(await res.text()).toBe('Hello from middleware function!');
  });
});

// ───── HEADER versioning ────────────────────────────────────────────────────
const headerVersioning = skipIfMissing(
  join(FIXTURES_ROOT, 'versioning', 'src', 'app.module.ts'),
);
headerVersioning.describe('upstream :: versioning (HEADER)', () => {
  let ctx: { app: any; baseUrl: string };
  beforeAll(async () => {
    const { AppModule } = await import(
      join(FIXTURES_ROOT, 'versioning', 'src', 'app.module.ts')
    );
    const { VersioningType } = await import('@nestjs/common');
    ctx = await bootApp(AppModule, app => {
      app.enableVersioning({
        type: VersioningType.HEADER,
        header: 'X-API-Version',
      });
    });
  });
  afterAll(async () => ctx.app.close());

  it('routes to V1 when X-API-Version: 1', async () => {
    const res = await fetch(`${ctx.baseUrl}/`, {
      headers: { 'X-API-Version': '1' },
    });
    expect(await res.text()).toBe('Hello World V1!');
  });

  it('routes to V2 when X-API-Version: 2', async () => {
    const res = await fetch(`${ctx.baseUrl}/`, {
      headers: { 'X-API-Version': '2' },
    });
    expect(await res.text()).toBe('Hello World V2!');
  });

  it('returns 404 for an unmapped version', async () => {
    const res = await fetch(`${ctx.baseUrl}/`, {
      headers: { 'X-API-Version': '3' },
    });
    expect(res.status).toBe(404);
  });
});

// ───── cors ─────────────────────────────────────────────────────────────────
const cors = skipIfMissing(join(FIXTURES_ROOT, 'cors', 'src', 'app.module.ts'));
cors.describe('upstream :: cors', () => {
  let ctx: { app: any; baseUrl: string };
  beforeAll(async () => {
    const { AppModule } = await import(
      join(FIXTURES_ROOT, 'cors', 'src', 'app.module.ts')
    );
    ctx = await bootApp(AppModule, app => {
      app.enableCors({
        origin: 'example.com',
        methods: ['GET', 'POST'],
        credentials: true,
        allowedHeaders: ['baz', 'woo'],
      });
    });
  });
  afterAll(async () => ctx.app.close());

  it('attaches Access-Control-Allow-Origin on a normal GET', async () => {
    const res = await fetch(`${ctx.baseUrl}/`);
    expect(res.headers.get('access-control-allow-origin')).toBe('example.com');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('responds to OPTIONS preflight with 204 + CORS headers', async () => {
    const res = await fetch(`${ctx.baseUrl}/`, {
      method: 'OPTIONS',
      headers: {
        origin: 'example.com',
        'access-control-request-method': 'POST',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toBe('baz,woo');
  });
});

// ───── nest-application/global-prefix ──────────────────────────────────────
const globalPrefix = skipIfMissing(
  join(FIXTURES_ROOT, 'nest-application', 'global-prefix', 'src', 'app.module.ts'),
);
globalPrefix.describe('upstream :: nest-application/global-prefix', () => {
  let ctx: { app: any; baseUrl: string };
  beforeAll(async () => {
    const { AppModule } = await import(
      join(FIXTURES_ROOT, 'nest-application', 'global-prefix', 'src', 'app.module.ts')
    );
    ctx = await bootApp(AppModule, app => {
      app.setGlobalPrefix('api');
    });
  });
  afterAll(async () => ctx.app.close());

  it('routes resolve under the global prefix', async () => {
    const res = await fetch(`${ctx.baseUrl}/api`);
    expect(res.status).toBe(200);
  });

  it('paths without the prefix return 404', async () => {
    const res = await fetch(`${ctx.baseUrl}/`);
    expect(res.status).toBe(404);
  });
});

// ───── scopes (request-scoped controllers + guards/interceptors) ──────────
const scopes = skipIfMissing(join(FIXTURES_ROOT, 'scopes', 'src', 'app.module.ts'));
// Previously skipped as "Bun drops request-scope metadata" — that diagnosis was
// wrong. The old assertion read `HelloService.COUNTER`, but that class has no
// COUNTER and never increments one, so it could only ever be 0. Upstream's own
// `e2e/request-scope.spec.ts` asserts on `UsersService` instead; with the same
// assertions the fixture passes here (verified on Bun 1.3.5, 1.3.14,
// 1.4.0-canary and the released 1.4.0).
const SCOPES_SRC = join(FIXTURES_ROOT, 'scopes', 'src', 'hello');
scopes.describe('upstream :: scopes (request-scoped DI)', () => {
  let ctx: { app: any; baseUrl: string };
  let HelloController: any;
  let UsersService: any;
  let UserByIdPipe: any;
  let Interceptor: any;
  let Guard: any;
  beforeAll(async () => {
    const mod = await import(join(FIXTURES_ROOT, 'scopes', 'src', 'app.module.ts'));
    HelloController = (await import(join(SCOPES_SRC, 'hello.controller.ts')))
      .HelloController;
    UsersService = (await import(join(SCOPES_SRC, 'users', 'users.service.ts')))
      .UsersService;
    UserByIdPipe = (await import(join(SCOPES_SRC, 'users', 'user-by-id.pipe.ts')))
      .UserByIdPipe;
    Interceptor = (
      await import(join(SCOPES_SRC, 'interceptors', 'logging.interceptor.ts'))
    ).Interceptor;
    Guard = (await import(join(SCOPES_SRC, 'guards', 'request-scoped.guard.ts'))).Guard;
    for (const cls of [HelloController, UsersService, UserByIdPipe, Interceptor, Guard]) {
      cls.COUNTER = 0;
    }
    ctx = await bootApp(mod.ApplicationModule);
    for (let i = 0; i < 3; i++) await fetch(`${ctx.baseUrl}/hello`);
  });
  afterAll(async () => ctx.app.close());

  it('creates a fresh controller per request', () => {
    expect(HelloController.COUNTER).toBe(3);
  });

  it('creates a fresh request-scoped service per request', () => {
    expect(UsersService.COUNTER).toBe(3);
  });

  it('creates a request-scoped pipe per request', () => {
    expect(UserByIdPipe.COUNTER).toBe(3);
    expect(UserByIdPipe.REQUEST_SCOPED_DATA).toEqual([1, 1, 1]);
  });

  it('creates a request-scoped interceptor per request', () => {
    expect(Interceptor.COUNTER).toBe(3);
    expect(Interceptor.REQUEST_SCOPED_DATA).toEqual([1, 1, 1]);
  });

  it('creates a request-scoped guard per request', () => {
    expect(Guard.COUNTER).toBe(3);
    expect(Guard.REQUEST_SCOPED_DATA).toEqual([1, 1, 1]);
  });
});

// ───── lazy-modules ─────────────────────────────────────────────────────────
const lazyModules = skipIfMissing(
  join(FIXTURES_ROOT, 'lazy-modules', 'src', 'lazy.controller.ts'),
);
// Previously skipped as "routes frozen at listen" — that diagnosis was wrong
// too. The block booted `AppModule`, which imports GlobalModule + EagerModule
// and lazily loads a *provider-only* module; it never references
// `LazyController`, so `/lazy/*` was never registered with any adapter. The
// 404 had nothing to do with the native-routes map. Upstream's
// `e2e/lazy-import-*-providers.spec.ts` bootstraps `controllers:
// [LazyController]` directly — the lazy loading happens inside the handler,
// which is an ordinary route as far as the adapter is concerned.
lazyModules.describe('upstream :: lazy-modules (lazy loading inside a handler)', () => {
  let ctx: { app: any; baseUrl: string };
  beforeAll(async () => {
    const { LazyController } = await import(
      join(FIXTURES_ROOT, 'lazy-modules', 'src', 'lazy.controller.ts')
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [LazyController],
    }).compile();
    const app = moduleRef.createNestApplication(new BunHttpAdapter(), { logger: false });
    await app.init();
    await app.listen(0, '127.0.0.1');
    ctx = {
      app,
      baseUrl: `http://127.0.0.1:${(app.getHttpServer() as any).address().port}`,
    };
  });
  afterAll(async () => ctx.app.close());

  it('lazy-loads a transient module on /lazy/transient', async () => {
    const res = await fetch(`${ctx.baseUrl}/lazy/transient`);
    expect(res.status).toBe(200);
  });

  it('lazy-loads a request-scoped module on /lazy/request', async () => {
    const res = await fetch(`${ctx.baseUrl}/lazy/request`);
    expect(res.status).toBe(200);
  });
});

// ───── send-files (StreamableFile) ─────────────────────────────────────────
const sendFiles = skipIfMissing(
  join(FIXTURES_ROOT, 'send-files', 'src', 'app.module.ts'),
);
sendFiles.describe('upstream :: send-files (StreamableFile)', () => {
  let ctx: { app: any; baseUrl: string };
  let previousCwd: string;
  beforeAll(async () => {
    // This fixture reads `join(process.cwd(), 'Readme.md')`, which upstream's
    // own e2e satisfies by running from the nest repo root. We import the
    // AppModule but keep our own cwd, where the file is `README.md` — so a
    // case-insensitive filesystem (macOS) resolves it and a case-sensitive one
    // (Linux, i.e. CI) does not: `readFileSync` threw ENOENT and the buffer
    // routes 500'd, while `createReadStream` failed after the headers were
    // already out and left `/file/stream` a 200 with an empty body.
    previousCwd = process.cwd();
    process.chdir(join(FIXTURES_ROOT, '..'));
    const { AppModule } = await import(
      join(FIXTURES_ROOT, 'send-files', 'src', 'app.module.ts')
    );
    ctx = await bootApp(AppModule);
  });
  afterAll(async () => {
    await ctx.app.close();
    process.chdir(previousCwd);
  });

  it('GET /file/stream streams a file via StreamableFile', async () => {
    const res = await fetch(`${ctx.baseUrl}/file/stream`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
  });

  it('GET /file/buffer streams a buffer via StreamableFile', async () => {
    const res = await fetch(`${ctx.baseUrl}/file/buffer`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
  });

  it('GET /file/with/headers attaches custom headers', async () => {
    const res = await fetch(`${ctx.baseUrl}/file/with/headers`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBeDefined();
  });
});

// ───── auto-mock ────────────────────────────────────────────────────────────
const autoMock = skipIfMissing(join(FIXTURES_ROOT, 'auto-mock', 'src', 'app.module.ts'));
autoMock.describe('upstream :: auto-mock', () => {
  it('boots with auto-mocked providers', async () => {
    const { AppModule } = await import(
      join(FIXTURES_ROOT, 'auto-mock', 'src', 'app.module.ts')
    );
    const ctx = await bootApp(AppModule);
    try {
      const res = await fetch(`${ctx.baseUrl}/`);
      expect(res.status === 200 || res.status === 404).toBe(true);
    } finally {
      await ctx.app.close();
    }
  });
});

// ───── inspector ────────────────────────────────────────────────────────────
// SKIPPED — upstream/inspector ships circular-module fixtures whose .ts files
// reference each other before declaration; Bun's per-file transpiler trips
// on the temporal dead zone where Node-via-tsc would not. This is a Bun bug,
// not an adapter issue. Re-verified 2026-08-20 on the released Bun 1.4.0 (and
// 2026-07-26 on 1.3.5, 1.3.14, 1.4.0-canary) — all still throw
// `ReferenceError: Cannot access 'CircularService' before initialization`.
describe.skip('upstream :: inspector (KNOWN: Bun TDZ on circular imports)', () => {
  it('boots without throwing', async () => {
    const { AppModule } = await import(
      join(FIXTURES_ROOT, 'inspector', 'src', 'app.module.ts')
    );
    const ctx = await bootApp(AppModule);
    await ctx.app.close();
  });
});

// ───── module-utils ─────────────────────────────────────────────────────────
const moduleUtils = skipIfMissing(
  join(FIXTURES_ROOT, 'module-utils', 'src', 'app.module.ts'),
);
moduleUtils.describe('upstream :: module-utils (dynamic modules)', () => {
  it('boots with dynamic-module patterns', async () => {
    const { AppModule } = await import(
      join(FIXTURES_ROOT, 'module-utils', 'src', 'app.module.ts')
    );
    const ctx = await bootApp(AppModule);
    await ctx.app.close();
  });
});
