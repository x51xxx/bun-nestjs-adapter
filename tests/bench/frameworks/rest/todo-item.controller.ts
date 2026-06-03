import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AccessGuard, Actions, UseAbility } from '@trishchuk/nest-casl';
import {
  CreateTodoItemInput,
  MergeTodoItemInput,
  Priority,
  TodoItemDTO,
  TodoItemFilterInput,
  UserDTO,
} from '../graphql/dto/todo-item.dto';
import { TodoItemService } from '../graphql/services/todo-item.service';

/**
 * REST mirror of `TodoItemResolver`. Same DTOs, same service, same CASL
 * permissions — only the protocol differs. Lets the bench isolate the
 * Apollo + GraphQL execution cost from everything else (validation,
 * resolver work, JSON encode).
 *
 * Each endpoint projects the response to EXACTLY the field set the matching
 * GraphQL query/mutation selects (see graphql-bench.ts), so the REST and
 * GraphQL payloads are byte-commensurate. The only residual difference is
 * GraphQL's `{"data":{…}}` envelope (~20 bytes). This includes mirroring
 * GraphQL's behaviour of emitting selected-but-null fields explicitly
 * (`description`/`dueAt` in byId) and resolving `assignee` only where the
 * GraphQL selection asks for it (list/byId/create — NOT merge).
 */
@Controller('todo-items')
@UseGuards(AccessGuard)
export class TodoItemRestController {
  constructor(private readonly service: TodoItemService) {}

  @Get()
  @UseAbility(Actions.read, TodoItemDTO)
  async list(
    @Query('skip', new ParseIntPipe({ optional: true })) skip = 0,
    @Query('take', new ParseIntPipe({ optional: true })) take = 20,
    @Query('completed') completed?: string,
    @Query('priority') priority?: Priority,
    @Query('titleContains') titleContains?: string,
  ) {
    const filter: TodoItemFilterInput | undefined =
      completed === undefined && priority === undefined && !titleContains
        ? undefined
        : {
            completed:
              completed === undefined
                ? undefined
                : completed === 'true' || completed === '1',
            priority,
            titleContains,
          };
    const items = await this.service.list({ skip, take, filter });
    return Promise.all(items.map(item => this.projectList(item)));
  }

  @Get(':id')
  @UseAbility(Actions.read, TodoItemDTO)
  async byId(@Param('id', ParseIntPipe) id: number) {
    const item = await this.service.byId(id);
    if (!item) throw new NotFoundException();
    return this.projectById(item);
  }

  @Post()
  @UseAbility(Actions.create, TodoItemDTO)
  async create(@Body() input: CreateTodoItemInput) {
    const item = await this.service.create(input);
    return this.projectCreate(item);
  }

  @Patch(':id/merge')
  @UseAbility(Actions.update, TodoItemDTO)
  async merge(@Param('id', ParseIntPipe) id: number, @Body() input: MergeTodoItemInput) {
    const item = await this.service.merge(id, input);
    if (!item) throw new NotFoundException();
    return this.projectMerge(item);
  }

  /**
   * In GraphQL the `assignee` is populated by `@ResolveField`. REST has no
   * field-resolver concept, so we emulate the same per-row lookup — equivalent
   * work, equivalent payload. Only called where the GraphQL selection includes
   * `assignee`.
   */
  private assigneeOf(item: TodoItemDTO): Promise<UserDTO | null> {
    return this.service.userById(item.assigneeId);
  }

  /**
   * `@IDField(() => ID)` fields (TodoItem.id, UserDTO.id, CommentDTO.id) are
   * serialised as strings by GraphQL's `ID` scalar, so the REST projection
   * stringifies them too for byte parity. Plain numeric fields like
   * `comment.authorId` stay numbers.
   */
  private projectAssignee(a: UserDTO | null) {
    return a ? { id: String(a.id), name: a.name, email: a.email } : null;
  }

  // ---- per-op projections (mirror graphql-bench.ts selection sets) ----

  /** LIST_QUERY: id title completed priority tags assignee comments{id body createdAt} checklist metadata createdAt updatedAt */
  private async projectList(item: TodoItemDTO) {
    return {
      id: String(item.id),
      title: item.title,
      completed: item.completed,
      priority: item.priority,
      tags: item.tags,
      assignee: this.projectAssignee(await this.assigneeOf(item)),
      comments: item.comments.map(c => ({
        id: String(c.id),
        body: c.body,
        createdAt: c.createdAt,
      })),
      checklist: item.checklist.map(c => ({ label: c.label, done: c.done })),
      metadata: item.metadata.map(m => ({ key: m.key, value: m.value })),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  /** BY_ID_QUERY: id title completed description priority tags dueAt assignee comments{id body authorId createdAt} checklist metadata createdAt updatedAt */
  private async projectById(item: TodoItemDTO) {
    return {
      id: String(item.id),
      title: item.title,
      completed: item.completed,
      description: item.description ?? null,
      priority: item.priority,
      tags: item.tags,
      dueAt: item.dueAt ?? null,
      assignee: this.projectAssignee(await this.assigneeOf(item)),
      comments: item.comments.map(c => ({
        id: String(c.id),
        body: c.body,
        authorId: c.authorId,
        createdAt: c.createdAt,
      })),
      checklist: item.checklist.map(c => ({ label: c.label, done: c.done })),
      metadata: item.metadata.map(m => ({ key: m.key, value: m.value })),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  /** CREATE_MUTATION: id title completed priority tags checklist metadata createdAt updatedAt assignee */
  private async projectCreate(item: TodoItemDTO) {
    return {
      id: String(item.id),
      title: item.title,
      completed: item.completed,
      priority: item.priority,
      tags: item.tags,
      checklist: item.checklist.map(c => ({ label: c.label, done: c.done })),
      metadata: item.metadata.map(m => ({ key: m.key, value: m.value })),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      assignee: this.projectAssignee(await this.assigneeOf(item)),
    };
  }

  /** MERGE_MUTATION: id title tags checklist metadata comments{id body createdAt} updatedAt (NO assignee) */
  private projectMerge(item: TodoItemDTO) {
    return {
      id: String(item.id),
      title: item.title,
      tags: item.tags,
      checklist: item.checklist.map(c => ({ label: c.label, done: c.done })),
      metadata: item.metadata.map(m => ({ key: m.key, value: m.value })),
      comments: item.comments.map(c => ({
        id: String(c.id),
        body: c.body,
        createdAt: c.createdAt,
      })),
      updatedAt: item.updatedAt,
    };
  }
}
