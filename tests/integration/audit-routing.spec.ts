/**
 * Regression tests for audit findings M3 / M4 / M5 (+ L1).
 *
 *   * M3 — a named wildcard (`@Get('files/*path')`) matched on the native-routes
 *     fast path but lost its capture (`params: {}`), and 404'd outright on the
 *     fallback `fetch` dispatcher because `compilePath` escaped `*path` as a
 *     literal. Both paths now agree, capture included.
 *   * M4 — `use()`/`forRoutes()` prefix matching was a bare `startsWith`, so
 *     middleware registered for `/user` also ran for `/users`.
 *   * M5 — `HEAD` on a `GET`-only route returned 404 on both dispatchers.
 *   * L1 — `/opt/:id?` never matched without the segment.
 *
 * Routing cases run through BOTH dispatchers: `withMiddleware: false` keeps the
 * native-routes fast path, `true` forces the manual `fetch` path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  Controller,
  Get,
  Head,
  Injectable,
  type MiddlewareConsumer,
  Module,
  type NestMiddleware,
  Param,
  Req,
  Sse,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Observable } from 'rxjs';
import { BunHttpAdapter, type BunRequest } from '../../src';
import { compilePath, matchesPathPrefix } from '../../src/http/router';

@Controller('r')
class RoutingController {
  @Get('files/*path')
  wildcard(@Req() req: BunRequest) {
    return { params: req.params };
  }

  @Get('maybe/{*splat}')
  optionalWildcard(@Req() req: BunRequest) {
    return { params: req.params };
  }

  @Get('re/:id(\\d+)')
  constrained(@Req() req: BunRequest) {
    return { params: req.params };
  }

  @Get('opt/:id?')
  optional(@Param('id') id?: string) {
    return { id: id ?? null };
  }

  @Get('ping')
  ping() {
    return { ok: true };
  }

  // The two payloads differ in length by a wide margin on purpose: with no
  // body to inspect on a HEAD response, `content-length` is the only way to
  // tell which handler ran.
  @Get('both')
  bothGet() {
    return { via: 'get', padding: 'x'.repeat(64) };
  }

  @Head('both')
  bothHead() {
    return { via: 'head' };
  }

  /** Reached only over HEAD, so its counters stay uncontaminated. */
  @Sse('stream-head')
  streamHead() {
    return tickingStream(headSse);
  }

  /** Reached only over GET — a live GET stream would otherwise keep counting. */
  @Sse('stream-get')
  streamGet() {
    return tickingStream(getSse);
  }
}

interface SseProbe {
  emissions: number;
  tornDown: boolean;
}
const headSse: SseProbe = { emissions: 0, tornDown: false };
const getSse: SseProbe = { emissions: 0, tornDown: false };

function tickingStream(probe: SseProbe) {
  return new Observable<{ data: { n: number } }>(subscriber => {
    const timer = setInterval(() => {
      probe.emissions++;
      subscriber.next({ data: { n: probe.emissions } });
    }, 5);
    return () => {
      probe.tornDown = true;
      clearInterval(timer);
    };
  });
}

@Injectable()
class PassThroughMiddleware implements NestMiddleware {
  use(_req: unknown, _res: unknown, next: () => void) {
    next();
  }
}

@Module({ controllers: [RoutingController] })
class FastModule {}

@Module({ controllers: [RoutingController] })
class SlowModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(PassThroughMiddleware).forRoutes('*');
  }
}

for (const withMiddleware of [false, true]) {
  const label = withMiddleware ? 'fetch dispatcher' : 'native routes';

  describe(`audit M3/M5 — ${label}`, () => {
    let app: Awaited<ReturnType<typeof Test.createTestingModule>> extends never
      ? never
      : Awaited<ReturnType<typeof bootstrap>>['app'];
    let base: string;

    async function bootstrap() {
      const moduleRef = await Test.createTestingModule({
        imports: [withMiddleware ? SlowModule : FastModule],
      }).compile();
      const app = moduleRef.createNestApplication(new BunHttpAdapter());
      await app.init();
      await app.listen(0);
      return { app };
    }

    beforeAll(async () => {
      ({ app } = await bootstrap());
      const { port } = (
        app.getHttpAdapter().getHttpServer() as unknown as {
          address(): { port: number };
        }
      ).address();
      base = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      await app.close();
    });

    // ── M3 ────────────────────────────────────────────────────────────────
    it('matches a named wildcard and exposes its capture', async () => {
      const res = await fetch(`${base}/r/files/a/b.txt`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ params: { path: 'a/b.txt' } });
    });

    it('matches a named wildcard spanning a single segment', async () => {
      const res = await fetch(`${base}/r/files/solo`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ params: { path: 'solo' } });
    });

    it('treats {*splat} as an optional wildcard', async () => {
      expect(await (await fetch(`${base}/r/maybe/x/y`)).json()).toEqual({
        params: { splat: 'x/y' },
      });
      expect(await (await fetch(`${base}/r/maybe`)).json()).toEqual({ params: {} });
    });

    it('keeps a constrained param under its declared name', async () => {
      // Bun's own matcher exposes this as the key `id(\d+)` and doesn't apply
      // the pattern, so the path must be routed by our matcher on both paths.
      expect(await (await fetch(`${base}/r/re/42`)).json()).toEqual({
        params: { id: '42' },
      });
    });

    // ── L1 ────────────────────────────────────────────────────────────────
    it('matches an optional param with and without the segment', async () => {
      expect(await (await fetch(`${base}/r/opt/7`)).json()).toEqual({ id: '7' });
      expect(await (await fetch(`${base}/r/opt`)).json()).toEqual({ id: null });
    });

    // ── M5 ────────────────────────────────────────────────────────────────
    it('serves HEAD from the GET handler', async () => {
      const res = await fetch(`${base}/r/ping`, { method: 'HEAD' });
      expect(res.status).toBe(200);
      // HEAD carries the headers of the GET response but no body.
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.text()).toBe('');
    });

    it('still prefers an explicitly registered HEAD route', async () => {
      const res = await fetch(`${base}/r/both`, { method: 'HEAD' });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-length')).toBe(
        String(JSON.stringify({ via: 'head' }).length),
      );
    });

    it('does not leave a streaming source running when HEAD hits an SSE route', async () => {
      headSse.emissions = 0;
      headSse.tornDown = false;

      const res = await fetch(`${base}/r/stream-head`, { method: 'HEAD' });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');

      // A HEAD response has no body, so the stream must never be created —
      // otherwise the observable produces into a buffer nobody drains and the
      // subscription never unwinds. (HEAD reaches @Sse() at all only because
      // of the GET fallback, so this is M5 re-opening H1 if left unguarded.)
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(headSse.tornDown).toBe(true);
      expect(headSse.emissions).toBe(0);
    });

    it('still streams SSE over GET', async () => {
      const res = await fetch(`${base}/r/stream-get`);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      await reader.read();
      await reader.cancel();
    });

    it('leaves GET untouched', async () => {
      expect(await (await fetch(`${base}/r/ping`)).json()).toEqual({ ok: true });
    });
  });
}

// ── M4 ──────────────────────────────────────────────────────────────────────
@Controller()
class PrefixController {
  @Get('user')
  user(@Req() req: BunRequest) {
    return { hit: req.headers['x-mw-hit'] ?? 'none' };
  }

  @Get('users')
  users(@Req() req: BunRequest) {
    return { hit: req.headers['x-mw-hit'] ?? 'none' };
  }

  @Get('user/edit')
  edit(@Req() req: BunRequest) {
    return { hit: req.headers['x-mw-hit'] ?? 'none' };
  }
}

@Injectable()
class TagMiddleware implements NestMiddleware {
  use(req: BunRequest, _res: unknown, next: () => void) {
    req.headers['x-mw-hit'] = 'yes';
    next();
  }
}

@Module({ controllers: [PrefixController] })
class PrefixModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TagMiddleware).forRoutes('user');
  }
}

describe('audit M4 — middleware prefix boundary', () => {
  let app: Awaited<ReturnType<typeof bootstrap>>['app'];
  let base: string;

  async function bootstrap() {
    const moduleRef = await Test.createTestingModule({
      imports: [PrefixModule],
    }).compile();
    const app = moduleRef.createNestApplication(new BunHttpAdapter());
    await app.init();
    await app.listen(0);
    return { app };
  }

  beforeAll(async () => {
    ({ app } = await bootstrap());
    const { port } = (
      app.getHttpAdapter().getHttpServer() as unknown as {
        address(): { port: number };
      }
    ).address();
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('runs for the exact prefix', async () => {
    expect(await (await fetch(`${base}/user`)).json()).toEqual({ hit: 'yes' });
  });

  it('runs for paths below the prefix', async () => {
    expect(await (await fetch(`${base}/user/edit`)).json()).toEqual({ hit: 'yes' });
  });

  it('does NOT run for a path that merely starts with the prefix', async () => {
    expect(await (await fetch(`${base}/users`)).json()).toEqual({ hit: 'none' });
  });
});

// ── unit level ──────────────────────────────────────────────────────────────
describe('audit M3/M4 — compilePath / matchesPathPrefix', () => {
  const match = (path: string, pathname: string) => {
    const { regexp, keys } = compilePath(path);
    const m = regexp.exec(pathname);
    if (!m) return null;
    return Object.fromEntries(
      keys.map((k, i) => [k.name, m[i + 1]]).filter(([, v]) => v !== undefined),
    );
  };

  it('captures a required named wildcard', () => {
    expect(match('/files/*path', '/files/a/b')).toEqual({ path: 'a/b' });
    expect(match('/files/*path', '/files')).toBeNull();
  });

  it('captures an optional named wildcard and allows it to be absent', () => {
    expect(match('/a/{*splat}', '/a/x/y')).toEqual({ splat: 'x/y' });
    expect(match('/a/{*splat}', '/a')).toEqual({});
  });

  it('keeps bare wildcards keyless', () => {
    expect(match('/any/*', '/any/x/y')).toEqual({});
    expect(match('*', '/whatever')).toEqual({});
  });

  it('treats a trailing ? as an optional param', () => {
    expect(match('/opt/:id?', '/opt/5')).toEqual({ id: '5' });
    expect(match('/opt/:id?', '/opt')).toEqual({});
  });

  it('matches path prefixes on segment boundaries only', () => {
    expect(matchesPathPrefix('/user', '/user')).toBe(true);
    expect(matchesPathPrefix('/user/', '/user')).toBe(true);
    expect(matchesPathPrefix('/user/edit', '/user')).toBe(true);
    expect(matchesPathPrefix('/users', '/user')).toBe(false);
    expect(matchesPathPrefix('/user-admin', '/user')).toBe(false);
    expect(matchesPathPrefix('/anything', '/')).toBe(true);
  });
});
