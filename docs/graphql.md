# GraphQL

GraphQL is **not** part of the adapter's public API — it's standard `@nestjs/graphql`
running on top of `BunHttpAdapter`. This page documents what the benchmark suite
exercises and how to wire it.

## Apollo (`@nestjs/apollo`)

`ApolloDriver` runs on `BunHttpAdapter` as it would on any Nest platform. The
benchmark target `graphql-nest-bun` boots exactly this:

```ts
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule } from '@nestjs/graphql';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      path: '/graphql',
    }),
  ],
})
export class AppModule {}
```

```ts
const app = await NestFactory.create(AppModule, new BunHttpAdapter());
await app.listen(3000);
```

## GraphQL Yoga — experimental `BunYogaDriver`

The stock `@graphql-yoga/nestjs` `YogaDriver` only supports
`httpAdapter.getType()` of `express` or `fastify` (it throws otherwise). Yoga is
fetch-native, so on Bun the natural integration is to hand the raw Web `Request`
straight to `yoga.handleRequest()` and stream the Web `Response` back — no Node
`req`/`res` bridge.

`BunYogaDriver` does exactly that. **It is bench-only tooling**
(`tests/bench/frameworks/graphql/bun-yoga-driver.ts`), not exported from the
package — it's a prototype used to measure the driver delta.

Two things matter when wiring it:

1. Boot with `{ bodyParser: false }` — Yoga reads the request body itself; the
   adapter must not consume the stream first.
2. The driver registers the GraphQL route on the `BunHttpAdapter` and resolves
   Yoga's `Response` through the adapter.

```ts
// experimental — see tests/bench for the full driver
const app = await NestFactory.create(YogaAppModule, new BunHttpAdapter(), {
  bodyParser: false,
});
await app.listen(3000);
```

### Apollo vs. Yoga on bun

In the local benchmark (`bun run tests/bench/run-matrix.ts --with-yoga`) the
Yoga driver is consistently ahead of Apollo on bun, with lower tail latency at
comparable RSS — because it skips the Node req/res bridge Apollo goes through.
Measured 2026-08-20 on Bun 1.4.0:

| size | Apollo RPS | Yoga RPS | Δ RPS | Apollo p99 | Yoga p99 | Δ p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| small | 3305 | **5235** | +58.4 % | 18.3 | 11.0 | −40.1 % |
| medium | 3203 | **4944** | +54.4 % | 31.2 | 20.1 | −35.6 % |
| large | 3375 | **5294** | +56.9 % | 53.4 | 33.0 | −38.2 % |

Full report: [`BENCHMARK-yoga-1.4.0.md`](../BENCHMARK-yoga-1.4.0.md) (GraphQL-only
matrix; the default [`BENCHMARK.md`](../BENCHMARK.md) excludes the Yoga target).
Numbers are hardware- and version-specific; re-measure on your target.

> If a published, supported `BunYogaDriver` is something you want, it's tracked
> on the roadmap in the top-level [`README.md`](../README.md).

Next: [Benchmarks →](./benchmarks.md)
