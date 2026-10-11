import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';

/**
 * Apollo driver for `BunHttpAdapter`, bench-only.
 *
 * `@nestjs/apollo`'s `registerServer()` dispatches on `httpAdapter.getType()`
 * and knows only `express` / `fastify` — anything else throws
 * `No support for current HttpAdapter: bun`. Apollo has no fetch-native
 * integration, so `bun` takes the Express one (`@as-integrations/express5`)
 * against the adapter's Node-shaped `req`/`res` shims; that bridge is exactly
 * what `BENCHMARK-FINDINGS.md` measures the cost of.
 *
 * Non-bun platforms delegate to the stock dispatch, so express/fastify targets
 * keep their native integrations and the same module works everywhere.
 */
export class BunApolloDriver extends ApolloDriver {
  override async registerServer(apolloOptions: ApolloDriverConfig): Promise<void> {
    if (this.httpAdapterHost.httpAdapter?.getType() === 'bun') {
      return this.registerExpress(apolloOptions);
    }
    return super.registerServer(apolloOptions);
  }
}
