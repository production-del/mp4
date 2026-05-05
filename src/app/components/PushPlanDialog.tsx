'use client';

/**
 * PushPlanDialog — the single 3-phase push dialog used everywhere.
 *
 * Replaces three near-identical dialogs that each implemented:
 *   confirm → pushing (progress bar) → done (success/failure breakdown).
 *
 * Callers supply an opaque list of `PushTask`s built by the push-tasks
 * helpers and a completion callback that receives the ids of successfully
 * pushed items (for cleanup in the planner's state).
 */

import { useCallback, useMemo, useState } from 'react';
import type { PushTask } from '@/lib/planning/push-tasks';

type DialogState =
  | { phase: 'confirm' }
  | { phase: 'pushing'; progress: number; current: string }
  | {
      phase: 'done';
      succeededIds: string[];
      failed: { label: string; error: string }[];
    };

interface PushPlanDialogProps {
  /** Built by `build*PushTasks` helpers. */
  tasks: PushTask[];
  /** Fires when the user closes (or after done). */
  onClose: () => void;
  /** Fires with the ids of all items pushed successfully. */
  onComplete: (succeededItemIds: string[]) => void;
  /** Optional title override (defaults to "Push to Unleashed"). */
  title?: string;
  /** Optional extra note shown under the title in the confirm phase. */
  subtitle?: string;
  /** Optional JSX inserted in the confirm phase between summary and buttons. */
  confirmExtras?: React.ReactNode;
  /** Optional disable condition for the push button (e.g., missing warehouse). */
  disableReason?: string | null;
}

export function PushPlanDialog({
  tasks,
  onClose,
  onComplete,
  title = 'Push to Unleashed',
  subtitle,
  confirmExtras,
  disableReason,
}: PushPlanDialogProps) {
  const [state, setState] = useState<DialogState>({ phase: 'confirm' });

  // Group tasks by variantLabel for the confirm-phase summary.
  const groupedByVariant = useMemo(() => {
    const groups = new Map<string, PushTask[]>();
    for (const t of tasks) {
      const list = groups.get(t.variantLabel) ?? [];
      list.push(t);
      groups.set(t.variantLabel, list);
    }
    return [...groups.entries()];
  }, [tasks]);

  const handlePush = useCallback(async () => {
    setState({ phase: 'pushing', progress: 0, current: '' });
    const succeededIds: string[] = [];
    const failed: { label: string; error: string }[] = [];

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      setState({ phase: 'pushing', progress: i, current: `${task.variantLabel}: ${task.label}` });
      try {
        await task.run();
        succeededIds.push(...task.itemIds);
      } catch (err) {
        failed.push({
          label: `${task.variantLabel}: ${task.label}`,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    setState({ phase: 'done', succeededIds, failed });
    if (succeededIds.length > 0) onComplete(succeededIds);
  }, [tasks, onComplete]);

  const canPush = tasks.length > 0 && !disableReason;

  return (
    <div
      className="fixed inset-0 bg-black/20 flex items-center justify-center z-50 p-4"
      onClick={state.phase === 'pushing' ? undefined : onClose}
    >
      <div
        className="rounded max-w-2xl w-full max-h-[80vh] flex flex-col"
        style={{ background: 'var(--bg-page)', border: '0.5px solid var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {state.phase === 'confirm' && (
          <>
            <div className="px-6 py-4" style={{ borderBottom: '0.5px solid var(--border)' }}>
              <h2 className="text-lg" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                {title}
              </h2>
              {subtitle && (
                <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                  {subtitle}
                </p>
              )}
            </div>

            <div className="px-6 py-4 flex-1 overflow-y-auto space-y-3">
              {/* Summary header */}
              <div className="rounded p-3" style={{ background: 'var(--bg-surface)' }}>
                <div className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                  Total tasks
                </div>
                <div className="text-2xl mt-0.5" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                  {tasks.length}
                </div>
              </div>

              {/* Per-variant breakdown */}
              {groupedByVariant.map(([variant, items]) => (
                <div
                  key={variant}
                  className="rounded"
                  style={{ border: '0.5px solid var(--border)' }}
                >
                  <div
                    className="px-3 py-2 flex items-center justify-between"
                    style={{ background: 'var(--bg-surface)', borderBottom: '0.5px solid var(--border)' }}
                  >
                    <span className="text-sm" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                      {variant}
                    </span>
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {items.length} task{items.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div className="max-h-[140px] overflow-y-auto">
                    {items.map((t) => (
                      <div
                        key={t.id}
                        className="px-3 py-1.5 text-sm truncate"
                        style={{ borderBottom: '0.5px solid var(--border)', color: 'var(--text-secondary)' }}
                      >
                        {t.label}
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {confirmExtras}

              {disableReason && (
                <div
                  className="rounded p-3 text-sm"
                  style={{
                    color: 'var(--warning)',
                    background: 'var(--warning-light)',
                    border: '0.5px solid var(--warning)',
                  }}
                >
                  {disableReason}
                </div>
              )}
            </div>

            <div className="px-6 py-4 flex justify-end gap-3" style={{ borderTop: '0.5px solid var(--border)' }}>
              <button
                onClick={onClose}
                className="px-4 py-2 rounded text-sm transition hover:opacity-80"
                style={{
                  color: 'var(--text-secondary)',
                  background: 'var(--bg-surface)',
                  border: '0.5px solid var(--border)',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handlePush}
                disabled={!canPush}
                className="px-4 py-2 rounded text-sm text-white transition hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ fontWeight: 500, background: 'var(--success)' }}
              >
                Push {tasks.length} Task{tasks.length !== 1 ? 's' : ''}
              </button>
            </div>
          </>
        )}

        {state.phase === 'pushing' && (
          <div className="px-6 py-8">
            <h2 className="text-lg mb-4" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
              Pushing to Unleashed…
            </h2>
            <div className="space-y-3">
              <div className="text-sm truncate" style={{ color: 'var(--text-secondary)' }}>
                {state.current}
              </div>
              <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-surface)' }}>
                <div
                  className="h-full transition-all duration-300"
                  style={{
                    background: 'var(--success)',
                    width: `${((state.progress + 1) / tasks.length) * 100}%`,
                  }}
                />
              </div>
              <div className="text-xs text-right" style={{ color: 'var(--text-muted)' }}>
                {state.progress + 1} / {tasks.length}
              </div>
            </div>
          </div>
        )}

        {state.phase === 'done' && (
          <div className="px-6 py-6">
            <h2 className="text-lg mb-4" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
              {state.failed.length === 0 ? 'Push Complete' : 'Push Finished with Errors'}
            </h2>

            <div className="space-y-3 mb-6">
              {state.succeededIds.length > 0 && (
                <div
                  className="rounded p-3 text-sm"
                  style={{
                    color: 'var(--success)',
                    background: 'var(--success-light)',
                    border: '0.5px solid var(--success)',
                  }}
                >
                  {state.succeededIds.length} item{state.succeededIds.length !== 1 ? 's' : ''} pushed successfully.
                </div>
              )}
              {state.failed.length > 0 && (
                <div
                  className="rounded p-3 text-sm space-y-2"
                  style={{ background: 'var(--danger-light)', border: '0.5px solid var(--danger)' }}
                >
                  <div style={{ fontWeight: 500, color: 'var(--danger)' }}>
                    {state.failed.length} failed:
                  </div>
                  {state.failed.map((f, i) => (
                    <div key={i} className="text-xs" style={{ color: 'var(--danger)' }}>
                      <span style={{ fontWeight: 500 }}>{f.label}</span>: {f.error}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded text-sm transition hover:opacity-80"
                style={{
                  color: 'var(--text-secondary)',
                  background: 'var(--bg-surface)',
                  border: '0.5px solid var(--border)',
                }}
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
