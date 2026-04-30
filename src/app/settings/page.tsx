'use client';

/**
 * Global settings page.
 *
 * Scope for v1: the Priority module's tunable parameters. Designed as a
 * section-based list so other global settings (fetch intervals, warehouse
 * policies, demand CSV pointer, …) can migrate here over time. No migration
 * of existing settings is performed as part of the Priority module launch.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  readPrioritySettings,
  updatePrioritySettings,
  resetPrioritySettings,
  type PrioritySettings,
} from '@/lib/planning/priority-settings';
import { countEnabledFlags, clearAllPriorityFlags } from '@/lib/planning/priority-flags';
import { DemandImport } from './components/DemandImport';

export default function SettingsPage() {
  const [settings, setSettings] = useState<PrioritySettings | null>(null);
  const [flagCount, setFlagCount] = useState(0);
  const [savedFlash, setSavedFlash] = useState(false);

  // Load from localStorage on mount. We avoid reading during render to keep
  // the server-rendered HTML empty (hydration-safe).
  useEffect(() => {
    setSettings(readPrioritySettings());
    setFlagCount(countEnabledFlags());
  }, []);

  const patch = useCallback((p: Partial<PrioritySettings>) => {
    updatePrioritySettings(p);
    setSettings(readPrioritySettings());
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1200);
  }, []);

  const reset = useCallback(() => {
    resetPrioritySettings();
    setSettings(readPrioritySettings());
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1200);
  }, []);

  const clearFlags = useCallback(() => {
    if (!confirm(`Clear priority flag on all ${flagCount} product${flagCount === 1 ? '' : 's'}?`)) return;
    clearAllPriorityFlags();
    setFlagCount(0);
  }, [flagCount]);

  if (!settings) {
    return (
      <div className="h-screen flex items-center justify-center" style={{ background: 'var(--bg-page)' }}>
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading settings...</div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: 'var(--bg-page)', color: 'var(--text-primary)' }}>
      {/* Header */}
      <div className="px-6 pt-5 pb-4 flex items-start justify-between" style={{ borderBottom: '0.5px solid var(--border)' }}>
        <div>
          <h1 className="text-xl" style={{ fontWeight: 500 }}>Settings</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Global parameters shared across planner modules. Changes save immediately to this browser.
          </p>
        </div>
        {savedFlash && (
          <span className="text-xs px-2 py-1 rounded" style={{ background: 'var(--success-light)', color: 'var(--success)', fontWeight: 500 }}>
            saved
          </span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-8 max-w-3xl">

        {/* ── Priority section ──────────────────────────────── */}
        <Section
          title="Priority Module"
          description={`Controls the Priorities page. ${flagCount} product${flagCount === 1 ? '' : 's'} currently flagged.`}
        >
          <SettingRow
            label="Deficit threshold"
            help="Propose a priority run when availableStock ≤ this value. 0 = only when over-allocated. Higher values propose earlier as a buffer."
          >
            <input
              type="number"
              value={settings.deficitThreshold}
              onChange={(e) => patch({ deficitThreshold: Number(e.target.value) })}
              className="w-24 px-2 py-1 text-sm font-mono rounded text-right"
              style={{
                background: 'var(--bg-surface)',
                border: '0.5px solid var(--border)',
                color: 'var(--text-primary)',
              }}
            />
          </SettingRow>

          <SettingRow
            label="Transfer source preference"
            help="When a priority run needs an intermediate moved to MF Packaging, these warehouses are consulted in order. First one with enough stock wins."
          >
            <input
              type="text"
              value={settings.transferSourcePreference.join(', ')}
              onChange={(e) =>
                patch({
                  transferSourcePreference: e.target.value
                    .split(',')
                    .map(s => s.trim())
                    .filter(Boolean),
                })
              }
              className="w-full px-2 py-1 text-sm rounded"
              style={{
                background: 'var(--bg-surface)',
                border: '0.5px solid var(--border)',
                color: 'var(--text-primary)',
              }}
              placeholder="Lundberg Storeroom, MF Operations, TBC"
            />
          </SettingRow>

          <SettingRow
            label="Require approval"
            help="Priority proposals always require an operator click to become drafts. V1 hard-codes this on; the toggle is reserved for a future autopilot pass."
          >
            <label className="inline-flex items-center gap-2 text-sm" style={{ color: settings.requireApproval ? 'var(--text-primary)' : 'var(--text-muted)' }}>
              <input
                type="checkbox"
                checked={settings.requireApproval}
                disabled
                className="cursor-not-allowed"
              />
              {settings.requireApproval ? 'Yes (always, v1)' : 'No'}
            </label>
          </SettingRow>

          <SettingRow label="" help="">
            <div className="flex gap-2">
              <button
                onClick={reset}
                className="text-xs px-3 py-1.5 rounded transition hover:opacity-80"
                style={{
                  color: 'var(--text-secondary)',
                  background: 'var(--bg-surface)',
                  border: '0.5px solid var(--border)',
                }}
              >
                Reset priority settings
              </button>
              <button
                onClick={clearFlags}
                disabled={flagCount === 0}
                className="text-xs px-3 py-1.5 rounded transition hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  color: 'var(--danger)',
                  background: 'var(--danger-light)',
                  border: '0.5px solid var(--danger)',
                }}
              >
                Clear all priority flags ({flagCount})
              </button>
            </div>
          </SettingRow>
        </Section>

        {/* ── Demand Import ─────────────────────────────────────── */}
        <section>
          <header className="mb-3">
            <h2
              className="text-sm uppercase tracking-wider"
              style={{ fontWeight: 600, color: 'var(--text-secondary)' }}
            >
              Demand Import
            </h2>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              Upload a fresh demand CSV (e.g., from UDH) to override the server
              default. The Component Planner and Packaging Plan pick up the
              change immediately.
            </p>
          </header>
          <DemandImport />
        </section>

      </div>
    </div>
  );
}

// ─── UI helpers ────────────────────────────────────────────

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <header className="mb-3">
        <h2 className="text-sm uppercase tracking-wider" style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
          {title}
        </h2>
        {description && (
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            {description}
          </p>
        )}
      </header>
      <div className="rounded overflow-hidden" style={{ border: '0.5px solid var(--border)' }}>
        {children}
      </div>
    </section>
  );
}

function SettingRow({
  label,
  help,
  children,
}: {
  label: string;
  help: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex items-start gap-4 px-4 py-3"
      style={{ borderBottom: '0.5px solid var(--border)', background: 'var(--bg-surface)' }}
    >
      <div className="flex-1 min-w-0">
        {label && (
          <div className="text-sm" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
            {label}
          </div>
        )}
        {help && (
          <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {help}
          </div>
        )}
      </div>
      <div className="flex-shrink-0 min-w-[180px]">
        {children}
      </div>
    </div>
  );
}
