'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import type { Task, TaskStatus, TaskPriority } from './task-types';
import { STATUS_LABELS, STATUS_ORDER, PRIORITY_ORDER } from './task-types';
import { TaskStore } from './task-store';

// ─── Helpers ──────────────────────────────────────────────

function generateId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

function isOverdue(dueDate: string | null): boolean {
  if (!dueDate) return false;
  const due = new Date(dueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return due < today;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

const PRIORITY_COLORS: Record<TaskPriority, string> = {
  high: 'var(--danger)',
  medium: 'var(--warning)',
  low: 'var(--text-muted)',
};

// ─── Page ─────────────────────────────────────────────────

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [team, setTeam] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  // UI state
  const [showAddForm, setShowAddForm] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [collapsedLanes, setCollapsedLanes] = useState<Record<string, boolean>>({});
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [quickInput, setQuickInput] = useState('');
  const [filterPersons, setFilterPersons] = useState<Set<string>>(new Set());

  // Load from store on mount
  useEffect(() => {
    setTasks(TaskStore.loadTasks());
    setTeam(TaskStore.loadTeam());
    setLoaded(true);
  }, []);

  // Persist tasks
  const persistTasks = useCallback((next: Task[]) => {
    setTasks(next);
    TaskStore.saveTasks(next);
  }, []);

  // Persist team
  const persistTeam = useCallback((next: string[]) => {
    setTeam(next);
    TaskStore.saveTeam(next);
  }, []);

  // ── CRUD ────────────────────────────────────────────────

  const addTask = useCallback((task: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>) => {
    const now = nowISO();
    const newTask: Task = {
      ...task,
      id: generateId(),
      createdAt: now,
      updatedAt: now,
    };
    persistTasks([...tasks, newTask]);
  }, [tasks, persistTasks]);

  const updateTask = useCallback((updated: Task) => {
    const next = tasks.map(t => t.id === updated.id ? { ...updated, updatedAt: nowISO() } : t);
    persistTasks(next);
  }, [tasks, persistTasks]);

  const deleteTask = useCallback((id: string) => {
    persistTasks(tasks.filter(t => t.id !== id));
  }, [tasks, persistTasks]);

  const moveTask = useCallback((taskId: string, newStatus: TaskStatus, newAssignee?: string) => {
    const next = tasks.map(t =>
      t.id === taskId
        ? { ...t, status: newStatus, ...(newAssignee != null ? { assignee: newAssignee } : {}), updatedAt: nowISO() }
        : t,
    );
    persistTasks(next);
  }, [tasks, persistTasks]);

  // ── Drag and drop ───────────────────────────────────────

  const handleDragStart = useCallback((e: React.DragEvent, taskId: string) => {
    e.dataTransfer.setData('text/plain', taskId);
    e.dataTransfer.effectAllowed = 'move';
    setDraggedTaskId(taskId);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, status: TaskStatus, assignee: string) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData('text/plain');
    if (taskId) {
      moveTask(taskId, status, assignee);
    }
    setDraggedTaskId(null);
  }, [moveTask]);

  const handleDragEnd = useCallback(() => {
    setDraggedTaskId(null);
  }, []);

  // ── Lane collapse ───────────────────────────────────────

  const toggleLane = useCallback((person: string) => {
    setCollapsedLanes(prev => ({ ...prev, [person]: !prev[person] }));
  }, []);

  // ── Stats ───────────────────────────────────────────────

  const stats = useMemo(() => {
    const counts: Record<TaskStatus, number> = { backlog: 0, todo: 0, in_progress: 0, done: 0 };
    for (const t of tasks) counts[t.status]++;
    return { total: tasks.length, ...counts };
  }, [tasks]);

  // ── Tasks grouped by person ─────────────────────────────

  const tasksByPerson = useMemo(() => {
    const map: Record<string, Task[]> = {};
    for (const person of team) {
      map[person] = [];
    }
    for (const t of tasks) {
      if (!map[t.assignee]) map[t.assignee] = [];
      map[t.assignee].push(t);
    }
    return map;
  }, [tasks, team]);

  // Don't render until loaded from localStorage
  if (!loaded) {
    return (
      <div className="h-screen flex items-center justify-center" style={{ background: 'var(--bg-page)' }}>
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading tasks...</div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: 'var(--bg-page)', color: 'var(--text-primary)' }}>
      {/* Header */}
      <div className="px-6 pt-5 pb-4" style={{ borderBottom: '0.5px solid var(--border)' }}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>Tasks</h1>
            <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
              Team task board — drag cards between columns
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowSettings(true)}
              className="px-3 py-1.5 rounded text-sm transition hover:opacity-80"
              style={{ color: 'var(--text-secondary)', border: '0.5px solid var(--border)', fontWeight: 400 }}
            >
              Settings
            </button>
            <button
              onClick={() => { setEditingTask(null); setShowAddForm(true); }}
              className="px-3 py-1.5 rounded text-sm text-white transition hover:opacity-80"
              style={{ background: 'var(--accent)', fontWeight: 500 }}
            >
              Add Task
            </button>
          </div>
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-5 gap-3">
          {[
            { label: 'Total', value: stats.total, color: stats.total > 0 ? 'var(--accent)' : undefined },
            { label: 'Backlog', value: stats.backlog, color: stats.backlog > 0 ? 'var(--text-secondary)' : undefined },
            { label: 'To Do', value: stats.todo, color: stats.todo > 0 ? 'var(--accent)' : undefined },
            { label: 'In Progress', value: stats.in_progress, color: stats.in_progress > 0 ? 'var(--warning)' : undefined },
            { label: 'Done', value: stats.done, color: stats.done > 0 ? 'var(--success)' : undefined },
          ].map(card => (
            <div key={card.label} className="rounded px-4 py-3" style={{ background: 'var(--bg-surface)' }}>
              <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                {card.label}
              </div>
              <div className="text-2xl mt-0.5" style={{ fontWeight: 500, color: card.color || 'var(--text-primary)' }}>
                {card.value}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Quick input */}
      <div className="px-6 py-2.5 flex items-center gap-2" style={{ borderBottom: '0.5px solid var(--border)' }}>
        <input
          type="text"
          value={quickInput}
          onChange={e => setQuickInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && quickInput.trim()) {
              addTask({
                title: quickInput.trim(),
                description: '',
                assignee: (filterPersons.size === 1 ? [...filterPersons][0] : null) ?? team[0] ?? 'Unassigned',
                status: 'todo',
                priority: 'medium',
                dueDate: null,
              });
              setQuickInput('');
            }
          }}
          placeholder={filterPersons.size === 1 ? `Quick add task for ${[...filterPersons][0]}...` : 'Quick add — type a task and press Enter'}
          className="flex-1 rounded px-3 py-1.5 text-sm focus:outline-none"
          style={{
            color: 'var(--text-primary)',
            background: 'var(--bg-surface)',
            border: '0.5px solid var(--border)',
          }}
        />
        <button
          onClick={() => {
            if (quickInput.trim()) {
              addTask({
                title: quickInput.trim(),
                description: '',
                assignee: team[0] ?? 'Unassigned',
                status: 'todo',
                priority: 'medium',
                dueDate: null,
              });
              setQuickInput('');
            }
          }}
          disabled={!quickInput.trim()}
          className="px-3 py-1.5 rounded text-sm text-white transition hover:opacity-80 disabled:opacity-30 disabled:cursor-not-allowed"
          style={{ background: 'var(--accent)', fontWeight: 500 }}
        >
          Add
        </button>
      </div>

      {/* Person filter */}
      {team.length > 0 && (
        <div className="px-6 py-2 flex items-center gap-1.5" style={{ borderBottom: '0.5px solid var(--border)' }}>
          <button
            onClick={() => setFilterPersons(new Set())}
            className="px-2.5 py-1 rounded text-xs transition whitespace-nowrap"
            style={{
              fontWeight: filterPersons.size === 0 ? 500 : 400,
              color: filterPersons.size === 0 ? 'var(--accent)' : 'var(--text-muted)',
              background: filterPersons.size === 0 ? 'var(--accent-light)' : 'transparent',
              border: `0.5px solid ${filterPersons.size === 0 ? 'var(--accent)' : 'var(--border)'}`,
            }}
          >
            All
          </button>
          {team.map(person => {
            const active = filterPersons.has(person);
            const count = (tasksByPerson[person] || []).length;
            return (
              <button
                key={person}
                onClick={() => setFilterPersons(prev => {
                  const next = new Set(prev);
                  if (next.has(person)) next.delete(person);
                  else next.add(person);
                  return next;
                })}
                className="px-2.5 py-1 rounded text-xs transition whitespace-nowrap"
                style={{
                  fontWeight: active ? 500 : 400,
                  color: active ? 'var(--accent)' : 'var(--text-muted)',
                  background: active ? 'var(--accent-light)' : 'transparent',
                  border: `0.5px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                }}
              >
                {person}
                <span className="ml-1 opacity-60">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Kanban board */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {team.length === 0 ? (
          <div className="flex items-center justify-center py-20">
            <div className="text-center">
              <div className="text-sm" style={{ color: 'var(--text-muted)' }}>No team members configured</div>
              <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                Open Settings to add team members
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            {team.filter(p => filterPersons.size === 0 || filterPersons.has(p)).map(person => {
              const personTasks = tasksByPerson[person] || [];
              const collapsed = collapsedLanes[person] ?? false;
              const taskCount = personTasks.length;

              return (
                <div key={person} className="rounded" style={{ border: '0.5px solid var(--border)' }}>
                  {/* Lane header */}
                  <button
                    onClick={() => toggleLane(person)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition"
                    style={{ background: 'var(--bg-surface)' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-surface)'; }}
                  >
                    <span className="text-xs" style={{ color: 'var(--text-muted)', fontWeight: 500, width: 12, textAlign: 'center' }}>
                      {collapsed ? '>' : 'v'}
                    </span>
                    <span className="text-sm" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                      {person}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: 'var(--text-muted)', background: 'var(--bg-page)' }}>
                      {taskCount} task{taskCount !== 1 ? 's' : ''}
                    </span>
                  </button>

                  {/* Columns */}
                  {!collapsed && (
                    <div className="grid grid-cols-4" style={{ borderTop: '0.5px solid var(--border)' }}>
                      {STATUS_ORDER.map((status, colIdx) => {
                        const colTasks = personTasks
                          .filter(t => t.status === status)
                          .sort((a, b) => {
                            const pi = PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority);
                            if (pi !== 0) return pi;
                            return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
                          });

                        return (
                          <div
                            key={status}
                            className="flex flex-col min-h-[100px]"
                            style={{
                              borderRight: colIdx < 3 ? '0.5px solid var(--border)' : undefined,
                            }}
                            onDragOver={handleDragOver}
                            onDrop={e => handleDrop(e, status, person)}
                          >
                            {/* Column header */}
                            <div className="px-3 py-1.5 flex items-center justify-between" style={{ borderBottom: '0.5px solid var(--border)' }}>
                              <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)', fontWeight: 600 }}>
                                {STATUS_LABELS[status]}
                              </span>
                              <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
                                {colTasks.length}
                              </span>
                            </div>

                            {/* Cards */}
                            <div className="flex-1 p-1.5 space-y-1">
                              {colTasks.map(task => (
                                <div
                                  key={task.id}
                                  draggable
                                  onDragStart={e => handleDragStart(e, task.id)}
                                  onDragEnd={handleDragEnd}
                                  onClick={() => { setEditingTask(task); setShowAddForm(true); }}
                                  className="rounded px-2.5 py-2 cursor-pointer transition"
                                  style={{
                                    background: 'var(--bg-surface)',
                                    border: draggedTaskId === task.id ? '0.5px solid var(--accent)' : '0.5px solid var(--border)',
                                    opacity: status === 'done' ? 0.5 : 1,
                                  }}
                                  onMouseEnter={e => { if (status !== 'done') e.currentTarget.style.background = 'var(--bg-hover)'; }}
                                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-surface)'; }}
                                >
                                  {/* Priority dot + title */}
                                  <div className="flex items-start gap-1.5">
                                    <div
                                      className="w-1.5 h-1.5 rounded-full mt-1 flex-shrink-0"
                                      style={{ background: PRIORITY_COLORS[task.priority] }}
                                      title={task.priority}
                                    />
                                    <span className="text-xs leading-tight" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                                      {task.title}
                                    </span>
                                  </div>

                                  {/* Description (truncated) */}
                                  {task.description && (
                                    <div
                                      className="text-[10px] mt-1 leading-snug overflow-hidden"
                                      style={{
                                        color: 'var(--text-muted)',
                                        display: '-webkit-box',
                                        WebkitLineClamp: 2,
                                        WebkitBoxOrient: 'vertical',
                                      }}
                                    >
                                      {task.description}
                                    </div>
                                  )}

                                  {/* Due date */}
                                  {task.dueDate && (
                                    <div
                                      className="text-[10px] mt-1"
                                      style={{
                                        color: isOverdue(task.dueDate) && status !== 'done'
                                          ? 'var(--danger)'
                                          : 'var(--text-muted)',
                                        fontWeight: isOverdue(task.dueDate) && status !== 'done' ? 500 : 400,
                                      }}
                                    >
                                      Due {formatDate(task.dueDate)}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Add/Edit Task Modal */}
      {showAddForm && (
        <TaskFormModal
          task={editingTask}
          team={team}
          onSave={task => {
            if (editingTask) {
              updateTask({ ...editingTask, ...task, id: editingTask.id, createdAt: editingTask.createdAt, updatedAt: editingTask.updatedAt });
            } else {
              addTask(task);
            }
            setShowAddForm(false);
            setEditingTask(null);
          }}
          onDelete={editingTask ? () => {
            deleteTask(editingTask.id);
            setShowAddForm(false);
            setEditingTask(null);
          } : undefined}
          onClose={() => { setShowAddForm(false); setEditingTask(null); }}
        />
      )}

      {/* Settings Panel */}
      {showSettings && (
        <SettingsPanel
          team={team}
          onUpdateTeam={persistTeam}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

// ─── Task Form Modal ──────────────────────────────────────

function TaskFormModal({
  task,
  team,
  onSave,
  onDelete,
  onClose,
}: {
  task: Task | null;
  team: string[];
  onSave: (data: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [assignee, setAssignee] = useState(task?.assignee ?? team[0] ?? 'Unassigned');
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'backlog');
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? 'medium');
  const [dueDate, setDueDate] = useState(task?.dueDate ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isEdit = task !== null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onSave({
      title: title.trim(),
      description: description.trim(),
      assignee,
      status,
      priority,
      dueDate: dueDate || null,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg shadow-xl"
        style={{ background: 'var(--bg-page)', border: '0.5px solid var(--border)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: '0.5px solid var(--border)' }}>
          <h2 className="text-sm" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
            {isEdit ? 'Edit Task' : 'Add Task'}
          </h2>
          <button
            onClick={onClose}
            className="text-xs px-2 py-0.5 rounded transition hover:opacity-70"
            style={{ color: 'var(--text-muted)' }}
          >
            Close
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-3">
          {/* Title */}
          <div>
            <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
              Title
            </label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Task title"
              autoFocus
              required
              className="w-full rounded px-3 py-1.5 text-xs focus:outline-none"
              style={{ background: 'var(--bg-surface)', border: '0.5px solid var(--border)', color: 'var(--text-primary)' }}
            />
          </div>

          {/* Assignee + Priority row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                Assignee
              </label>
              <select
                value={assignee}
                onChange={e => setAssignee(e.target.value)}
                className="w-full rounded px-3 py-1.5 text-xs focus:outline-none"
                style={{ background: 'var(--bg-surface)', border: '0.5px solid var(--border)', color: 'var(--text-primary)' }}
              >
                {team.map(p => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                Priority
              </label>
              <select
                value={priority}
                onChange={e => setPriority(e.target.value as TaskPriority)}
                className="w-full rounded px-3 py-1.5 text-xs focus:outline-none"
                style={{ background: 'var(--bg-surface)', border: '0.5px solid var(--border)', color: 'var(--text-primary)' }}
              >
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>

          {/* Status + Due date row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                Status
              </label>
              <select
                value={status}
                onChange={e => setStatus(e.target.value as TaskStatus)}
                className="w-full rounded px-3 py-1.5 text-xs focus:outline-none"
                style={{ background: 'var(--bg-surface)', border: '0.5px solid var(--border)', color: 'var(--text-primary)' }}
              >
                {STATUS_ORDER.map(s => (
                  <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                Due Date
              </label>
              <input
                type="date"
                value={dueDate}
                onChange={e => setDueDate(e.target.value)}
                className="w-full rounded px-3 py-1.5 text-xs focus:outline-none"
                style={{ background: 'var(--bg-surface)', border: '0.5px solid var(--border)', color: 'var(--text-primary)' }}
              />
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
              Description
            </label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Optional description"
              rows={3}
              className="w-full rounded px-3 py-1.5 text-xs focus:outline-none resize-none"
              style={{ background: 'var(--bg-surface)', border: '0.5px solid var(--border)', color: 'var(--text-primary)' }}
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-between pt-2">
            <div>
              {onDelete && (
                confirmDelete ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs" style={{ color: 'var(--danger)' }}>Delete this task?</span>
                    <button
                      type="button"
                      onClick={onDelete}
                      className="text-xs px-2 py-1 rounded text-white transition hover:opacity-80"
                      style={{ background: 'var(--danger)', fontWeight: 500 }}
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      className="text-xs px-2 py-1 rounded transition hover:opacity-70"
                      style={{ color: 'var(--text-muted)', border: '0.5px solid var(--border)' }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    className="text-xs px-2 py-1 rounded transition hover:opacity-70"
                    style={{ color: 'var(--danger)', border: '0.5px solid var(--border)' }}
                  >
                    Delete
                  </button>
                )
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="text-xs px-3 py-1.5 rounded transition hover:opacity-70"
                style={{ color: 'var(--text-secondary)', border: '0.5px solid var(--border)' }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!title.trim()}
                className="text-xs px-3 py-1.5 rounded text-white transition hover:opacity-80 disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ background: 'var(--accent)', fontWeight: 500 }}
              >
                {isEdit ? 'Save Changes' : 'Add Task'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Settings Panel ───────────────────────────────────────

function SettingsPanel({
  team,
  onUpdateTeam,
  onClose,
}: {
  team: string[];
  onUpdateTeam: (team: string[]) => void;
  onClose: () => void;
}) {
  const [newMember, setNewMember] = useState('');

  const addMember = () => {
    const name = newMember.trim();
    if (!name || team.includes(name)) return;
    onUpdateTeam([...team, name]);
    setNewMember('');
  };

  const removeMember = (name: string) => {
    onUpdateTeam(team.filter(p => p !== name));
  };

  const moveMember = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= team.length) return;
    const next = [...team];
    [next[index], next[target]] = [next[target], next[index]];
    onUpdateTeam(next);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-lg shadow-xl"
        style={{ background: 'var(--bg-page)', border: '0.5px solid var(--border)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: '0.5px solid var(--border)' }}>
          <h2 className="text-sm" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Settings</h2>
          <button
            onClick={onClose}
            className="text-xs px-2 py-0.5 rounded transition hover:opacity-70"
            style={{ color: 'var(--text-muted)' }}
          >
            Close
          </button>
        </div>

        <div className="px-5 py-4">
          <div className="text-[10px] uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
            Team Members
          </div>

          {/* Existing members */}
          <div className="space-y-1 mb-3">
            {team.map((person, idx) => (
              <div
                key={person}
                className="flex items-center justify-between px-3 py-1.5 rounded"
                style={{ background: 'var(--bg-surface)' }}
              >
                <span className="text-xs" style={{ color: 'var(--text-primary)' }}>{person}</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => moveMember(idx, -1)}
                    disabled={idx === 0}
                    className="text-[10px] px-1 py-0.5 rounded transition hover:opacity-70 disabled:opacity-20 disabled:cursor-not-allowed"
                    style={{ color: 'var(--text-muted)' }}
                    title="Move up"
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => moveMember(idx, 1)}
                    disabled={idx === team.length - 1}
                    className="text-[10px] px-1 py-0.5 rounded transition hover:opacity-70 disabled:opacity-20 disabled:cursor-not-allowed"
                    style={{ color: 'var(--text-muted)' }}
                    title="Move down"
                  >
                    ↓
                  </button>
                  <button
                    onClick={() => removeMember(person)}
                    className="text-[10px] px-1.5 py-0.5 rounded transition hover:opacity-70 ml-1"
                    style={{ color: 'var(--danger)', background: 'var(--danger-light)' }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
            {team.length === 0 && (
              <div className="text-xs py-2" style={{ color: 'var(--text-muted)' }}>No team members</div>
            )}
          </div>

          {/* Add member */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newMember}
              onChange={e => setNewMember(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addMember(); } }}
              placeholder="New member name"
              className="flex-1 rounded px-3 py-1.5 text-xs focus:outline-none"
              style={{ background: 'var(--bg-surface)', border: '0.5px solid var(--border)', color: 'var(--text-primary)' }}
            />
            <button
              onClick={addMember}
              disabled={!newMember.trim() || team.includes(newMember.trim())}
              className="text-xs px-3 py-1.5 rounded text-white transition hover:opacity-80 disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ background: 'var(--accent)', fontWeight: 500 }}
            >
              Add
            </button>
          </div>

          <div className="text-[10px] mt-3" style={{ color: 'var(--text-muted)' }}>
            Team members appear as swim lanes on the task board. Tasks assigned to removed members will still display under their name until reassigned.
          </div>
        </div>
      </div>
    </div>
  );
}
