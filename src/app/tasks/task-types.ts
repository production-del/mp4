export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'done';
export type TaskPriority = 'high' | 'medium' | 'low';

export interface Task {
  id: string;
  title: string;
  description: string;
  assignee: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null; // ISO date string
  createdAt: string;
  updatedAt: string;
  // Future: asanaTaskId, notionPageId
  externalId?: string;
  externalSource?: 'asana' | 'notion';
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  in_progress: 'In Progress',
  done: 'Done',
};

export const STATUS_ORDER: TaskStatus[] = ['backlog', 'todo', 'in_progress', 'done'];

export const PRIORITY_ORDER: TaskPriority[] = ['high', 'medium', 'low'];
