import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Controller, Get, Module, Options as OptionsMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BunHttpAdapter } from '../../src';

// Regression tests for the 2026-09-06 audit (see AUDIT.md):
//
//   M2 — `enableCors()` short-circuited *every* `OPTIONS` request to 204, so a
//        user's own `@Options()` handler never ran. Only a real preflight (one
//        carrying `Access-Control-Request-Method`) may be answered that way.
//   M7 — a classic static mount never percent-decoded the path, so any asset
//        with a space or a non-ASCII character in its name was unreachable —
//        while the same file served fine through `{ native: true }`.

let app: { close(): Promise<unknown>; getHttpServer(): any } | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

async function boot(
  moduleClass: unknown,
  configure?: (app: any) => void,
): Promise<string> {
  const created = await NestFactory.create(moduleClass as never, new BunHttpAdapter(), {
    logger: false,
  });
  configure?.(created);
  await created.listen(0, '127.0.0.1');
  app = created as never;
  return `http://127.0.0.1:${created.getHttpServer().address().port}`;
}

// ── M2 ──────────────────────────────────────────────────────────────────────

@Controller()
class OptionsController {
  @OptionsMethod('opt')
  opt() {
    return { custom: 'options' };
  }

  @Get('ping')
  ping() {
    return { ok: true };
  }
}

@Module({ controllers: [OptionsController] })
class OptionsModule {}

const PREFLIGHT = {
  origin: 'https://app.example',
  'access-control-request-method': 'GET',
};

describe('M2 — CORS only answers real preflights', () => {
  it('lets a user @Options() route run when the request is not a preflight', async () => {
    const base = await boot(OptionsModule, a => a.enableCors({ origin: true }));
    const res = await fetch(`${base}/opt`, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ custom: 'options' });
  });

  it('still applies the CORS headers to that non-preflight response', async () => {
    const base = await boot(OptionsModule, a => a.enableCors({ origin: true }));
    const res = await fetch(`${base}/opt`, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example' },
    });
    await res.arrayBuffer();
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example');
  });

  it('short-circuits a real preflight to 204 before the route', async () => {
    const base = await boot(OptionsModule, a => a.enableCors({ origin: true }));
    const res = await fetch(`${base}/opt`, { method: 'OPTIONS', headers: PREFLIGHT });
    expect(res.status).toBe(204);
    expect((await res.text()).length).toBe(0);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example');
  });

  it('preflights a route that has no @Options() handler', async () => {
    const base = await boot(OptionsModule, a => a.enableCors({ origin: true }));
    const res = await fetch(`${base}/ping`, { method: 'OPTIONS', headers: PREFLIGHT });
    expect(res.status).toBe(204);
  });

  it('404s a plain OPTIONS that no route owns — as it does with CORS off', async () => {
    const withCors = await boot(OptionsModule, a => a.enableCors({ origin: true }));
    const a = await fetch(`${withCors}/ping`, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example' },
    });
    await a.arrayBuffer();
    await app?.close();
    app = null;

    const withoutCors = await boot(OptionsModule);
    const b = await fetch(`${withoutCors}/ping`, { method: 'OPTIONS' });
    await b.arrayBuffer();

    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
  });
});

// ── M7 ──────────────────────────────────────────────────────────────────────

// Written at runtime rather than committed: a fixture file whose name carries
// non-ASCII bytes is at the mercy of git and of the filesystem's Unicode
// normalisation. Creating and reading it through the same runtime keeps the
// test honest on macOS and Linux alike.
let sandbox = '';
let root = '';

/** Content marker for the file *outside* the mount, kept out of every URL under
 *  test so a 404 body echoing the path can't be mistaken for a leak. */
const OUTSIDE_MARKER = 'LEAKED_PAYLOAD_MARKER';

@Module({})
class EmptyModule {}

describe('M7 — classic static mounts percent-decode the path', () => {
  beforeAll(async () => {
    // `root` is a *subdirectory* of the sandbox, so the file a traversal would
    // reach has somewhere to live that is still ours to clean up.
    sandbox = await fs.mkdtemp(join(tmpdir(), 'bun-adapter-static-'));
    root = join(sandbox, 'public');
    await fs.mkdir(root);
    await fs.writeFile(join(root, 'my file.txt'), 'spaced');
    await fs.writeFile(join(root, 'café.txt'), 'accented');
    await fs.writeFile(join(root, 'index.html'), '<h1>index</h1>');
    await fs.mkdir(join(root, 'nested'));
    await fs.writeFile(join(root, 'nested', 'deep file.txt'), 'nested-spaced');
    await fs.writeFile(join(sandbox, 'outside.txt'), OUTSIDE_MARKER);
  });

  afterAll(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  const mount = (a: any) => a.useStaticAssets(root, { prefix: '/s' });

  it('serves a file whose name contains a space', async () => {
    const base = await boot(EmptyModule, mount);
    const res = await fetch(`${base}/s/my%20file.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('spaced');
  });

  it('serves a file whose name is non-ASCII', async () => {
    const base = await boot(EmptyModule, mount);
    const res = await fetch(`${base}/s/${encodeURIComponent('café.txt')}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('accented');
  });

  it('decodes every segment, not just the last', async () => {
    const base = await boot(EmptyModule, mount);
    const res = await fetch(`${base}/s/nested/deep%20file.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('nested-spaced');
  });

  it('still serves the index for the bare prefix', async () => {
    const base = await boot(EmptyModule, mount);
    const res = await fetch(`${base}/s/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('index');
  });

  // Decoding without replacing the traversal guard would have opened these up:
  // the old `normalize()` check was only sound *because* nothing was decoded.
  //
  // Two layers are at work, and it matters which one catches what. Bun resolves
  // dot-segments in `Request.url` itself — verified with a raw socket, `GET
  // /s/%2e%2e/outside.txt` arrives at `fetch` already rewritten to
  // `/outside.txt`, so it never reaches the mount at all. What Bun leaves alone
  // is `%2F`, `%5C` and `%00`: those arrive verbatim and are ours to reject.
  // The table below covers both, and the second group is what pins the guard.
  for (const [label, path] of [
    // Neutralised upstream by Bun's URL normalisation.
    ['literal ..', '/s/../outside.txt'],
    ['encoded .. segment', '/s/%2e%2e/outside.txt'],
    // Reach the mount encoded — rejected by decodeStaticSuffix().
    ['encoded separator', '/s/%2e%2e%2foutside.txt'],
    ['dots + encoded slash', '/s/..%2foutside.txt'],
    ['encoded backslash', '/s/%5C..%5Coutside.txt'],
    ['encoded NUL', '/s/%00.txt'],
  ] as const) {
    it(`refuses to escape the root — ${label}`, async () => {
      const base = await boot(EmptyModule, mount);
      const res = await fetch(`${base}${path}`);
      const body = await res.text();
      expect(res.status).not.toBe(200);
      expect(body).not.toContain(OUTSIDE_MARKER);
    });
  }

  it('rejects an encoded separator rather than descending into a subdirectory', async () => {
    // `%2F` survives Bun's normalisation, so a decoded segment holding a `/`
    // is a real escape attempt and must not resolve to `nested/deep file.txt`.
    const base = await boot(EmptyModule, mount);
    const res = await fetch(`${base}/s/nested%2Fdeep%20file.txt`);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('nested-spaced');
  });

  it('agrees with the native mount about an encoded filename', async () => {
    const classic = await boot(EmptyModule, mount);
    const classicRes = await fetch(`${classic}/s/my%20file.txt`);
    const classicBody = await classicRes.text();
    await app?.close();
    app = null;

    const native = await boot(EmptyModule, a =>
      a.useStaticAssets(root, { prefix: '/s', native: true }),
    );
    const nativeRes = await fetch(`${native}/s/my%20file.txt`);
    const nativeBody = await nativeRes.text();

    expect(classicRes.status).toBe(nativeRes.status);
    expect(classicBody).toBe(nativeBody);
    expect(classicBody).toBe('spaced');
  });
});
