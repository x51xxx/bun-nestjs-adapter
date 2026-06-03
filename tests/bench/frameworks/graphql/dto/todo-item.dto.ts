import { Field, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export enum Priority {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  URGENT = 'URGENT',
}
registerEnumType(Priority, { name: 'Priority' });

@ObjectType('User')
export class UserDTO {
  @Field(() => ID)
  id!: number;

  @Field()
  name!: string;

  @Field()
  email!: string;
}

@ObjectType('KeyValue')
export class KeyValueDTO {
  @Field()
  key!: string;

  @Field()
  value!: string;
}

@ObjectType('ChecklistItem')
export class ChecklistItemDTO {
  @Field()
  label!: string;

  @Field()
  done!: boolean;
}

@ObjectType('Comment')
export class CommentDTO {
  @Field(() => ID)
  id!: number;

  @Field()
  body!: string;

  @Field(() => Int)
  authorId!: number;

  @Field(() => Date)
  createdAt!: Date;
}

@ObjectType('TodoItem')
export class TodoItemDTO {
  @Field(() => ID)
  id!: number;

  @Field()
  title!: string;

  @Field()
  completed!: boolean;

  @Field({ nullable: true })
  description?: string;

  @Field(() => Priority)
  priority!: Priority;

  @Field(() => [String])
  tags!: string[];

  @Field(() => [ChecklistItemDTO])
  checklist!: ChecklistItemDTO[];

  @Field(() => [CommentDTO])
  comments!: CommentDTO[];

  @Field(() => [KeyValueDTO])
  metadata!: KeyValueDTO[];

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;

  @Field(() => Date, { nullable: true })
  dueAt?: Date;

  @Field(() => Int)
  assigneeId!: number;

  // Resolved by @ResolveField — exercises the field-resolver pipeline
  // every time a query selects `assignee { ... }`.
  @Field(() => UserDTO)
  assignee!: UserDTO;
}

// ---- Inputs ----

@InputType('ChecklistItemInput')
export class ChecklistItemInput {
  @Field()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label!: string;

  @Field({ defaultValue: false })
  @IsBoolean()
  done!: boolean;
}

@InputType('KeyValueInput')
export class KeyValueInput {
  @Field()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  key!: string;

  @Field()
  @IsString()
  @MaxLength(256)
  value!: string;
}

@InputType('CreateTodoItemInput')
export class CreateTodoItemInput {
  @Field()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @Field({ defaultValue: false })
  @IsBoolean()
  completed!: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @Field(() => Priority, { defaultValue: Priority.MEDIUM })
  @IsEnum(Priority)
  priority!: Priority;

  @Field(() => [String], { defaultValue: [] })
  @IsArray()
  @IsString({ each: true })
  tags!: string[];

  @Field(() => [ChecklistItemInput], { defaultValue: [] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChecklistItemInput)
  checklist!: ChecklistItemInput[];

  @Field(() => [KeyValueInput], { defaultValue: [] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KeyValueInput)
  metadata!: KeyValueInput[];

  @Field(() => Int, { defaultValue: 1 })
  @IsInt()
  @Min(1)
  assigneeId!: number;
}

@InputType('UpdateTodoItemInput')
export class UpdateTodoItemInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  completed?: boolean;

  @Field(() => Priority, { nullable: true })
  @IsOptional()
  @IsEnum(Priority)
  priority?: Priority;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

/**
 * Patch-style mutation. Exercises array Set merges (tags add/remove),
 * positional array append (checklist), object/map merge by key (metadata),
 * and a small dedup pass — these are the kind of operations real backends
 * run on every PATCH request and they dominate JSON encode/decode cost.
 */
@InputType('MergeTodoItemInput')
export class MergeTodoItemInput {
  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tagsToAdd?: string[];

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tagsToRemove?: string[];

  @Field(() => [ChecklistItemInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChecklistItemInput)
  checklistToAdd?: ChecklistItemInput[];

  @Field(() => [KeyValueInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KeyValueInput)
  metadataPatch?: KeyValueInput[];

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  commentToAdd?: string;
}

@InputType('TodoItemFilterInput')
export class TodoItemFilterInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  completed?: boolean;

  @Field(() => Priority, { nullable: true })
  @IsOptional()
  @IsEnum(Priority)
  priority?: Priority;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  titleContains?: string;
}
