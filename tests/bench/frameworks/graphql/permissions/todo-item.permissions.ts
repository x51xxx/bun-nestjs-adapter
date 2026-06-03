import { Actions, Permissions } from '@trishchuk/nest-casl';
import { TodoItemDTO } from '../dto/todo-item.dto';

export enum Roles {
  admin = 'admin',
  user = 'user',
}

export const todoItemPermissions: Permissions<Roles, TodoItemDTO, Actions> = {
  everyone({ can }) {
    can(Actions.read, TodoItemDTO);
    can(Actions.create, TodoItemDTO);
    can(Actions.update, TodoItemDTO);
  },
};
