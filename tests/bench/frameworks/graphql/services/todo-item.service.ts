import { Injectable } from '@nestjs/common';
import {
  ChecklistItemDTO,
  CommentDTO,
  CreateTodoItemInput,
  KeyValueDTO,
  MergeTodoItemInput,
  Priority,
  TodoItemDTO,
  TodoItemFilterInput,
  UpdateTodoItemInput,
  UserDTO,
} from '../dto/todo-item.dto';

const SEED_USERS = 50;
const SEED_ITEMS = 1000;
const PRIORITIES = [Priority.LOW, Priority.MEDIUM, Priority.HIGH, Priority.URGENT];
const TAG_POOL = [
  'urgent',
  'home',
  'work',
  'errands',
  'shopping',
  'health',
  'learning',
  'side-project',
  'meeting',
  'review',
];

const SAMPLE_DESCRIPTION =
  'Realistic todo description that mimics the payload size of a typical CRM/PM tool. ' +
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor ' +
  'incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud.';

const COMMENT_BODIES = [
  'Looks good to me, shipping soon.',
  'Needs another pair of eyes before merge.',
  'Bumping priority — customer is waiting.',
  'Already covered by the regression suite.',
  'Closing as duplicate of #123.',
];

const CHECKLIST_LABELS = [
  'Write spec',
  'Implement happy path',
  'Add error handling',
  'Cover with tests',
  'Update documentation',
  'Notify stakeholders',
];

function pseudoRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

@Injectable()
export class TodoItemService {
  private idSeq = 0;
  private commentSeq = 0;
  private readonly items = new Map<number, TodoItemDTO>();
  private readonly users = new Map<number, UserDTO>();
  // Pre-sorted list cache — invalidated on every mutation. Avoids paying
  // O(n) Map iteration + array materialisation per list query on the
  // unfiltered hot path.
  private cachedList: TodoItemDTO[] | null = null;

  constructor() {
    const rng = pseudoRandom(42);
    for (let i = 1; i <= SEED_USERS; i++) {
      this.users.set(i, {
        id: i,
        name: `User ${i}`,
        email: `user${i}@example.com`,
      });
    }
    const baseTime = Date.UTC(2024, 0, 1);
    for (let i = 0; i < SEED_ITEMS; i++) {
      const id = ++this.idSeq;
      const tagCount = Math.floor(rng() * 4);
      const tags: string[] = [];
      for (let t = 0; t < tagCount; t++) {
        tags.push(TAG_POOL[Math.floor(rng() * TAG_POOL.length)]);
      }
      const checklistCount = 1 + Math.floor(rng() * 4);
      const checklist: ChecklistItemDTO[] = [];
      for (let c = 0; c < checklistCount; c++) {
        checklist.push({
          label: CHECKLIST_LABELS[Math.floor(rng() * CHECKLIST_LABELS.length)],
          done: rng() < 0.3,
        });
      }
      const commentCount = 1 + Math.floor(rng() * 3);
      const comments: CommentDTO[] = [];
      for (let c = 0; c < commentCount; c++) {
        comments.push({
          id: ++this.commentSeq,
          body: COMMENT_BODIES[Math.floor(rng() * COMMENT_BODIES.length)],
          authorId: 1 + Math.floor(rng() * SEED_USERS),
          createdAt: new Date(baseTime + id * 60_000 + c * 3_600_000),
        });
      }
      const metadata: KeyValueDTO[] = [
        { key: 'source', value: rng() < 0.5 ? 'web' : 'mobile' },
        { key: 'estimate', value: `${1 + Math.floor(rng() * 8)}h` },
      ];
      const item: TodoItemDTO = {
        id,
        title: `Todo task #${id}`,
        completed: rng() < 0.4,
        description: rng() < 0.7 ? SAMPLE_DESCRIPTION : undefined,
        priority: PRIORITIES[Math.floor(rng() * PRIORITIES.length)],
        tags,
        checklist,
        comments,
        metadata,
        createdAt: new Date(baseTime + id * 60_000),
        updatedAt: new Date(baseTime + id * 60_000 + 30_000),
        dueAt: rng() < 0.6 ? new Date(baseTime + id * 60_000 + 86_400_000) : undefined,
        assigneeId: 1 + Math.floor(rng() * SEED_USERS),
        // Field resolver populates `assignee` per request — keep undefined here.
        assignee: undefined as unknown as UserDTO,
      };
      this.items.set(id, item);
    }
  }

  /**
   * `await Promise.resolve()` introduces a microtask boundary so the call
   * is genuinely async (matches how an ORM hands off to the event loop)
   * without injecting a sleep that would mask adapter-level differences.
   */
  async list(args: {
    skip: number;
    take: number;
    filter?: TodoItemFilterInput;
  }): Promise<TodoItemDTO[]> {
    await Promise.resolve();
    const { skip, take, filter } = args;
    let source: Iterable<TodoItemDTO>;
    if (!filter) {
      if (!this.cachedList) {
        this.cachedList = Array.from(this.items.values());
      }
      source = this.cachedList;
    } else {
      source = this.items.values();
    }
    const out: TodoItemDTO[] = [];
    let skipped = 0;
    for (const item of source) {
      if (filter) {
        if (filter.completed !== undefined && item.completed !== filter.completed)
          continue;
        if (filter.priority && item.priority !== filter.priority) continue;
        if (
          filter.titleContains &&
          !item.title.toLowerCase().includes(filter.titleContains.toLowerCase())
        ) {
          continue;
        }
      }
      if (skipped < skip) {
        skipped++;
        continue;
      }
      out.push(item);
      if (out.length >= take) break;
    }
    return out;
  }

  async byId(id: number): Promise<TodoItemDTO | null> {
    await Promise.resolve();
    return this.items.get(id) ?? null;
  }

  async create(input: CreateTodoItemInput): Promise<TodoItemDTO> {
    await Promise.resolve();
    const now = new Date();
    const item: TodoItemDTO = {
      id: ++this.idSeq,
      title: input.title,
      completed: input.completed,
      description: input.description,
      priority: input.priority,
      tags: input.tags ?? [],
      checklist: input.checklist?.map(c => ({ ...c })) ?? [],
      comments: [],
      metadata: input.metadata?.map(m => ({ ...m })) ?? [],
      createdAt: now,
      updatedAt: now,
      assigneeId: input.assigneeId,
      assignee: undefined as unknown as UserDTO,
    };
    this.items.set(item.id, item);
    this.cachedList = null;
    return item;
  }

  async update(id: number, input: UpdateTodoItemInput): Promise<TodoItemDTO | null> {
    await Promise.resolve();
    const item = this.items.get(id);
    if (!item) return null;
    if (input.title !== undefined) item.title = input.title;
    if (input.completed !== undefined) item.completed = input.completed;
    if (input.priority !== undefined) item.priority = input.priority;
    if (input.description !== undefined) item.description = input.description;
    item.updatedAt = new Date();
    this.cachedList = null;
    return item;
  }

  /**
   * Patch a todo with array/object merges — the workload that dominates
   * real PATCH endpoints. Returns the full item so the response payload
   * also exercises the JSON encode path.
   */
  async merge(id: number, input: MergeTodoItemInput): Promise<TodoItemDTO | null> {
    await Promise.resolve();
    const item = this.items.get(id);
    if (!item) return null;

    // 1. Tags: union add then set-difference remove (dedup'd).
    if (input.tagsToAdd?.length) {
      const set = new Set(item.tags);
      for (const t of input.tagsToAdd) set.add(t);
      item.tags = Array.from(set);
    }
    if (input.tagsToRemove?.length) {
      const drop = new Set(input.tagsToRemove);
      item.tags = item.tags.filter(t => !drop.has(t));
    }

    // 2. Checklist: append, capped to keep the row size bounded.
    if (input.checklistToAdd?.length) {
      const merged = item.checklist.concat(
        input.checklistToAdd.map(c => ({ label: c.label, done: c.done })),
      );
      item.checklist = merged.length > 20 ? merged.slice(-20) : merged;
    }

    // 3. Metadata: key-keyed object merge over an array-of-pairs shape.
    if (input.metadataPatch?.length) {
      const map = new Map(item.metadata.map(kv => [kv.key, kv.value]));
      for (const kv of input.metadataPatch) map.set(kv.key, kv.value);
      const out: KeyValueDTO[] = [];
      for (const [key, value] of map) out.push({ key, value });
      item.metadata = out;
    }

    // 4. Append a comment, ring-buffered to last 10.
    if (input.commentToAdd) {
      const next: CommentDTO = {
        id: ++this.commentSeq,
        body: input.commentToAdd,
        authorId: 1,
        createdAt: new Date(),
      };
      const merged = item.comments.concat(next);
      item.comments = merged.length > 10 ? merged.slice(-10) : merged;
    }

    item.updatedAt = new Date();
    this.cachedList = null;
    return item;
  }

  async userById(id: number): Promise<UserDTO | null> {
    await Promise.resolve();
    return this.users.get(id) ?? null;
  }

  /**
   * Modulo-based id selection — keeps the bench deterministic-ish without
   * hammering Math.random on every request. Caller passes a counter.
   */
  pickId(counter: number): number {
    return 1 + (counter % SEED_ITEMS);
  }
}
