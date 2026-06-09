/**
 * HTTPS support: `NestApplicationOptions.httpsOptions` must reach
 * `Bun.serve({ tls })` through `BunHttpAdapter.initHttpServer()`.
 *
 * Uses a self-signed localhost certificate fixture
 * (tests/integration/fixtures/own/tls, CN=localhost, SAN 127.0.0.1,
 * valid until 2126), so the client fetch disables verification via
 * Bun's `tls.rejectUnauthorized` request option.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Controller, Get } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BunHttpAdapter } from '../../src';

const TLS_DIR = join(__dirname, 'fixtures', 'own', 'tls');

@Controller()
class SecureController {
  @Get('secure')
  secure() {
    return { protocol: 'https', ok: true };
  }
}
@Module({ controllers: [SecureController] })
class SecureModule {}

// Bun-specific fetch extension: per-request TLS config.
const INSECURE_TLS = { tls: { rejectUnauthorized: false } } as RequestInit;

describe('platform-bun :: httpsOptions (self-signed cert)', () => {
  let app: any;
  let port: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SecureModule],
    }).compile();
    app = moduleRef.createNestApplication(new BunHttpAdapter(), {
      logger: false,
      httpsOptions: {
        key: readFileSync(join(TLS_DIR, 'key.pem')),
        cert: readFileSync(join(TLS_DIR, 'cert.pem')),
      },
    });
    await app.init();
    await app.listen(0, '127.0.0.1');
    port = app.getHttpServer().address().port;
  });

  afterAll(async () => app.close());

  it('serves requests over TLS', async () => {
    const res = await fetch(`https://127.0.0.1:${port}/secure`, INSECURE_TLS);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ protocol: 'https', ok: true });
  });

  it('serves the native-routes fast path over TLS too', async () => {
    // No middleware/CORS/static registered → Bun.serve({ routes }) is active;
    // both dispatch paths must work under the same TLS server.
    const res = await fetch(`https://127.0.0.1:${port}/secure`, INSECURE_TLS);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  // Note: a "rejects self-signed cert when verification is on" case is
  // intentionally absent — Bun's fetch skips certificate verification for
  // localhost/127.0.0.1, so it would test the client, not the adapter.

  it('refuses plain HTTP on the TLS port', async () => {
    await expect(fetch(`http://127.0.0.1:${port}/secure`)).rejects.toThrow();
  });
});

describe('platform-bun :: httpsOptions forwarding', () => {
  it('preserves TLS controls beyond key/cert/ca/passphrase', () => {
    const adapter = new BunHttpAdapter();
    const httpsOptions = {
      key: 'key-pem',
      cert: 'cert-pem',
      ca: 'ca-pem',
      passphrase: 'secret',
      requestCert: true,
      rejectUnauthorized: true,
      secureOptions: 0x02000000,
      serverName: 'api.example.com',
      ALPNProtocols: 'h2,http/1.1',
      ciphers: 'TLS_AES_256_GCM_SHA384',
      dhParamsFile: '/tmp/dhparams.pem',
    };

    adapter.initHttpServer({ httpsOptions } as any);

    expect(adapter.getHttpServer().tls).toEqual(httpsOptions);
  });
});

describe('platform-bun :: httpsOptions pass-through', () => {
  it('forwards mTLS and hardening fields, not just key/cert', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SecureModule],
    }).compile();
    const app = moduleRef.createNestApplication(new BunHttpAdapter(), {
      logger: false,
      httpsOptions: {
        key: readFileSync(join(TLS_DIR, 'key.pem')),
        cert: readFileSync(join(TLS_DIR, 'cert.pem')),
        requestCert: true,
        rejectUnauthorized: false,
        ciphers: 'TLS_AES_256_GCM_SHA384',
        secureOptions: 0x40000000,
      },
    });
    // initHttpServer() ran during createNestApplication — assert the config
    // reached the server object intact (never listens, nothing to close).
    const tls = app.getHttpServer().tls;
    expect(tls.requestCert).toBe(true);
    expect(tls.rejectUnauthorized).toBe(false);
    expect(tls.ciphers).toBe('TLS_AES_256_GCM_SHA384');
    expect(tls.secureOptions).toBe(0x40000000);
    expect(tls.key).toBeDefined();
    expect(tls.cert).toBeDefined();
  });
});
