// MVP: localStorage. Future: swap for Asana/Notion MCP adapter

import type { Task } from './task-types';

const TASKS_KEY = 'byron-tasks';
const TEAM_KEY = 'byron-tasks-team';

const DEFAULT_TEAM = ['James', 'Unassigned'];

export const TaskStore = {
  loadTasks(): Task[] {
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem(TASKS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },

  saveTasks(tasks: Task[]): void {
    if (typeof window === 'undefined') return;
    localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
  },

  loadTeam(): string[] {
    if (typeof window === 'undefined') return DEFAULT_TEAM;
    try {
      const raw = localStorage.getItem(TEAM_KEY);
      return raw ? JSON.parse(raw) : DEFAULT_TEAM;
    } catch {
      return DEFAULT_TEAM;
    }
  },

  saveTeam(team: string[]): void {
    if (typeof window === 'undefined') return;
    localStorage.setItem(TEAM_KEY, JSON.stringify(team));
  },
};
