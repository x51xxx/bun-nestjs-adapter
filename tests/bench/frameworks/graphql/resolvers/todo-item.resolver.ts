import { UseGuards } from '@nestjs/common';
import {
  Args,
  Int,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import { AccessGuard, Actions, UseAbility } from '@trishchuk/nest-casl';
import {
  CommentDTO,
  CreateTodoItemInput,
  MergeTodoItemInput,
  TodoItemDTO,
  TodoItemFilterInput,
  UpdateTodoItemInput,
  UserDTO,
} from '../dto/todo-item.dto';
import { TodoItemService } from '../services/todo-item.service';

@Resolver(() => TodoItemDTO)
@UseGuards(AccessGuard)
export class TodoItemResolver {
  constructor(private readonly service: TodoItemService) {}

  @Query(() => [TodoItemDTO], { name: 'todoItems' })
  @UseAbility(Actions.read, TodoItemDTO)
  todoItems(
    @Args('skip', { type: () => Int, defaultValue: 0 }) skip: number,
    @Args('take', { type: () => Int, defaultValue: 20 }) take: number,
    @Args('filter', { type: () => TodoItemFilterInput, nullable: true })
    filter?: TodoItemFilterInput,
  ): Promise<TodoItemDTO[]> {
    return this.service.list({ skip, take, filter });
  }

  @Query(() => TodoItemDTO, { name: 'todoItem', nullable: true })
  @UseAbility(Actions.read, TodoItemDTO)
  todoItem(@Args('id', { type: () => Int }) id: number): Promise<TodoItemDTO | null> {
    return this.service.byId(id);
  }

  @Mutation(() => TodoItemDTO, { name: 'createOneTodoItem' })
  @UseAbility(Actions.create, TodoItemDTO)
  createOneTodoItem(@Args('input') input: CreateTodoItemInput): Promise<TodoItemDTO> {
    return this.service.create(input);
  }

  @Mutation(() => TodoItemDTO, { name: 'updateOneTodoItem', nullable: true })
  @UseAbility(Actions.update, TodoItemDTO)
  updateOneTodoItem(
    @Args('id', { type: () => Int }) id: number,
    @Args('input') input: UpdateTodoItemInput,
  ): Promise<TodoItemDTO | null> {
    return this.service.update(id, input);
  }

  @Mutation(() => TodoItemDTO, { name: 'mergeTodoItem', nullable: true })
  @UseAbility(Actions.update, TodoItemDTO)
  mergeTodoItem(
    @Args('id', { type: () => Int }) id: number,
    @Args('input') input: MergeTodoItemInput,
  ): Promise<TodoItemDTO | null> {
    return this.service.merge(id, input);
  }

  @ResolveField(() => UserDTO, { name: 'assignee' })
  resolveAssignee(@Parent() todo: TodoItemDTO): Promise<UserDTO | null> {
    return this.service.userById(todo.assigneeId);
  }

  // Returning the already-loaded comments lets clients opt in to the
  // nested data without forcing every list request to encode it.
  @ResolveField(() => [CommentDTO], { name: 'comments' })
  resolveComments(@Parent() todo: TodoItemDTO): CommentDTO[] {
    return todo.comments;
  }
}
