import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import { BunHttpAdapter } from '../../src';
import { applyValidation } from '../bench/frameworks/graphql/bootstrap';
import { YogaAppModule } from '../bench/frameworks/graphql/modules/app-yoga.module';

/**
 * End-to-end check that BunHttpAdapter serves GraphQL via the experimental
 * `BunYogaDriver`. The POST cases are the important ones: they prove Yoga reads
 * the request body itself (the app boots with `bodyParser: false` so the
 * adapter doesn't consume the stream first).
 */
let app: any;
let url: string;

async function gql(query: string, variables?: Record<string, unknown>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe('platform-bun :: GraphQL Yoga driver (BunYogaDriver)', () => {
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [YogaAppModule],
    }).compile();
    app = moduleRef.createNestApplication(new BunHttpAdapter(), {
      logger: false,
      bodyParser: false,
    });
    applyValidation(app);
    await app.init();
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address();
    url = `http://127.0.0.1:${port}/graphql`;
  });
  afterAll(async () => app.close());

  it('serves a list query over POST (body read by Yoga, not the adapter)', async () => {
    const { status, body } = await gql(
      'query L($skip:Int!,$take:Int!){ todoItems(skip:$skip,take:$take){ id title } }',
      { skip: 0, take: 2 },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data.todoItems).toHaveLength(2);
    expect(body.data.todoItems[0]).toHaveProperty('id');
    expect(body.data.todoItems[0]).toHaveProperty('title');
  });

  it('resolves a single item with the @ResolveField assignee', async () => {
    const { status, body } = await gql(
      'query B($id:Int!){ todoItem(id:$id){ id title assignee{ id name } } }',
      { id: 1 },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data.todoItem.id).toBe('1');
    expect(body.data.todoItem.assignee).toHaveProperty('name');
  });

  it('runs a create mutation', async () => {
    const { status, body } = await gql(
      'mutation C($input:CreateTodoItemInput!){ createOneTodoItem(input:$input){ id title priority } }',
      {
        input: {
          title: 'Made via Yoga',
          completed: false,
          priority: 'HIGH',
          tags: [],
          checklist: [],
          metadata: [],
          assigneeId: 3,
        },
      },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data.createOneTodoItem.title).toBe('Made via Yoga');
  });

  it('reports GraphQL errors with a 200 + errors array (not a crash)', async () => {
    const { body } = await gql('query { nonExistentField }');
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.data).toBeFalsy();
  });

  it('serves GraphiQL on a GET request (no body)', async () => {
    const res = await fetch(url, { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect((await res.text()).toLowerCase()).toContain('graphiql');
  });
});
