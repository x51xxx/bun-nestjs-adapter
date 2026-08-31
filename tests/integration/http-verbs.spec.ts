/**
 * Regression tests for the HTTP verbs that `Bun.serve({ routes })` refuses as
 * method keys.
 *
 *   * `@Search()` — registered fine, but `buildBunRoutes()` put a `SEARCH` key
 *     on the native route object, so `Bun.serve()` threw
 *     `ERR_INVALID_ARG_TYPE` and the app never came up. Only apps on the
 *     native-routes fast path were affected; a middleware/CORS/classic-static
 *     app moved to the manual dispatcher and worked.
 *   * `@QueryMethod()` — new in Nest 12. `AbstractHttpAdapter.query()` now
 *     exists, so `RouterMethodFactory` no longer falls back to `use()` and
 *     instead delegated to `this.instance.query(...)`, which is `undefined`
 *     here: every app with a QUERY route crashed during `listen()`.
 *
 * Both verbs now stay off the native map and fall through to the manual
 * dispatcher, while the standard verbs on the *same* path keep the fast path.
 *
 * Also pins `@SseSignal()` (Nest 12): the signal handed to an `@Sse()` handler
 * must abort when the client disconnects, which only works because the request
 * shim's `socket` shares the request's EventEmitter.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  Body,
  Controller,
  Get,
  Injectable,
  type MiddlewareConsumer,
  Module,
  type NestMiddleware,
  QueryMethod,
  Search,
  Sse,
  SseSignal,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Observable } from 'rxjs';
import { BunHttpAdapter } from '../../src';
import { isBunNativeMethod } from '../../src/http/router';

@Controller('v')
class VerbController {
  // Shares a path with the SEARCH handler below on purpose: the path must stay
  // on the native map for GET while SEARCH is dropped from it.
  @Get('items')
  getItems() {
    return { via: 'get' };
  }

  @Search('items')
  searchItems() {
    return { via: 'search' };
  }

  // QUERY carries a request body by spec, so pin that it reaches @Body().
  @QueryMethod('items')
  queryItems(@Body() body: unknown) {
    return { via: 'query', body };
  }

  /** No standard verb on this path — it must leave the native map entirely. */
  @Search('search-only')
  searchOnly() {
    return { via: 'search-only' };
  }
}

let sseSignal: AbortSignal | undefined;

@Controller('sse')
class SseController {
  @Sse('signal')
  stream(@SseSignal() signal: AbortSignal) {
    sseSignal = signal;
    return new Observable<{ data: { n: number } }>(subscriber => {
      let n = 0;
      const timer = setInterval(() => subscriber.next({ data: { n: n++ } }), 5);
      return () => clearInterval(timer);
    });
  }
}

@Injectable()
class PassThroughMiddleware implements NestMiddleware {
  use(_req: unknown, _res: unknown, next: () => void) {
    next();
  }
}

@Module({ controllers: [VerbController, SseController] })
class FastModule {}

@Module({ controllers: [VerbController, SseController] })
class SlowModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(PassThroughMiddleware).forRoutes('*');
  }
}

describe('isBunNativeMethod', () => {
  it('accepts only the verbs Bun.serve() takes as route keys', () => {
    for (const m of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
      expect(isBunNativeMethod(m)).toBe(true);
    }
    for (const m of ['SEARCH', 'QUERY', 'PROPFIND', 'MKCOL', 'ALL']) {
      expect(isBunNativeMethod(m)).toBe(false);
    }
  });
});

for (const withMiddleware of [false, true]) {
  const label = withMiddleware ? 'fetch dispatcher' : 'native routes';

  describe(`non-native HTTP verbs — ${label}`, () => {
    let app: Awaited<ReturnType<typeof bootstrap>>['app'];
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
      // A SEARCH or QUERY route used to make this throw on the fast path.
      ({ app } = await bootstrap());
      base = await app.getUrl();
    });

    afterAll(async () => {
      await app?.close();
    });

    it('serves SEARCH on a path it shares with GET', async () => {
      const res = await fetch(`${base}/v/items`, { method: 'SEARCH' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ via: 'search' });
    });

    it('serves QUERY on a path it shares with GET, body included', async () => {
      const res = await fetch(`${base}/v/items`, {
        method: 'QUERY',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filter: 'name' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ via: 'query', body: { filter: 'name' } });
    });

    it('keeps GET on the same path working', async () => {
      const res = await fetch(`${base}/v/items`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ via: 'get' });
    });

    it('serves a path that has no standard verb at all', async () => {
      const res = await fetch(`${base}/v/search-only`, { method: 'SEARCH' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ via: 'search-only' });
    });

    it('still 404s an unregistered verb on a known path', async () => {
      const res = await fetch(`${base}/v/search-only`);
      expect(res.status).toBe(404);
    });

    it('aborts the @SseSignal() signal when the client disconnects', async () => {
      sseSignal = undefined;
      const controller = new AbortController();
      const res = await fetch(`${base}/sse/signal`, { signal: controller.signal });
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      // Read one chunk so the handler has definitely run and subscribed.
      await res.body!.getReader().read();
      expect(sseSignal).toBeDefined();
      expect(sseSignal!.aborted).toBe(false);

      controller.abort();
      await Bun.sleep(50);
      expect(sseSignal!.aborted).toBe(true);
    });
  });
}
