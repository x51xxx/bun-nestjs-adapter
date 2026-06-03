import { AbstractYogaDriver, type YogaDriverConfig } from '@graphql-yoga/nestjs';
import { createYoga } from 'graphql-yoga';

/**
 * Experimental GraphQL Yoga driver for `BunHttpAdapter`.
 *
 * The stock `YogaDriver` only supports `httpAdapter.getType()` of `express` or
 * `fastify` (it throws otherwise). Yoga is fetch-native, so on Bun we skip the
 * Node `req`/`res` bridge entirely: hand the untouched Web `Request` (which the
 * adapter exposes as `req.bunRequest`) straight to `yoga.handleRequest()` and
 * stream the Web `Response` back through the adapter.
 *
 * IMPORTANT: boot the Nest app with `{ bodyParser: false }`. Otherwise the
 * adapter's body parser consumes the request stream before Yoga reads it, and
 * POST queries arrive with an empty body.
 *
 * For non-bun platforms it delegates to the stock express/fastify path, so the
 * same driver works everywhere.
 */
export class BunYogaDriver extends AbstractYogaDriver {
  async start(options: YogaDriverConfig): Promise<void> {
    const httpAdapter = this.httpAdapterHost.httpAdapter;
    if (httpAdapter.getType() !== 'bun') {
      return super.start(options);
    }

    const opts = {
      ...options,
      maskedErrors: options.maskedErrors ?? false,
      graphiql: options.graphiql ?? process.env.NODE_ENV !== 'production',
    };
    const { conditionalSchema, ...rest } = opts as YogaDriverConfig & {
      conditionalSchema?: unknown;
    };
    const schema = (this as any).mergeConditionalSchema(conditionalSchema, rest.schema);

    const yoga = createYoga({
      ...rest,
      schema,
      graphqlEndpoint: rest.path ?? '/graphql',
      logging: rest.logging ?? false,
    });
    (this as any).yoga = yoga;

    httpAdapter.all(yoga.graphqlEndpoint, async (req: any, res: any) => {
      const request: Request = req.bunRequest;
      const response: Response = await yoga.handleRequest(request, { req, res });
      res.status(response.status);
      response.headers.forEach((value: string, key: string) => res.set(key, value));
      res.send(response.body ?? null);
    });
  }

  async stop(): Promise<void> {
    // noop — the route lives on the shared Bun.serve owned by the HTTP adapter
  }
}
