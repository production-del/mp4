'use client';

import type { PackagingSettings } from '../hooks/usePackagingConfig';

interface SettingsPanelProps {
  settings: PackagingSettings;
  onUpdateSettings: (patch: Partial<PackagingSettings>) => void;
  onUpdateFetchIntervals: (patch: Partial<PackagingSettings['fetchIntervals']>) => void;
  onResetToDefaults: () => void;
  onClose: () => void;
}

function NumberInput({
  label,
  value,
  onChange,
  min,
  max,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <label className="text-lg" style={{ color: 'var(--text-secondary)' }}>{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!isNaN(v)) onChange(v);
          }}
          className="w-20 px-2 py-1 rounded text-lg text-right focus:outline-none transition"
          style={{
            color: 'var(--text-primary)',
            background: 'var(--bg-page)',
            border: '0.5px solid var(--border)',
          }}
        />
        {suffix && <span className="text-base" style={{ color: 'var(--text-muted)' }}>{suffix}</span>}
      </div>
    </div>
  );
}

export function SettingsPanel({
  settings,
  onUpdateSettings,
  onUpdateFetchIntervals,
  onResetToDefaults,
  onClose,
}: SettingsPanelProps) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />

      {/* Panel */}
      <div
        className="relative w-96 overflow-y-auto"
        style={{ background: 'var(--bg-page)', borderLeft: '0.5px solid var(--border)' }}
      >
        <div
          className="sticky top-0 px-6 py-4 flex items-center justify-between"
          style={{ background: 'var(--bg-page)', borderBottom: '0.5px solid var(--border)' }}
        >
          <h2 className="text-[22px]" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>Settings</h2>
          <button
            onClick={onClose}
            className="text-2xl transition hover:opacity-70"
            style={{ color: 'var(--text-muted)' }}
          >
            ✕
          </button>
        </div>

        <div className="px-6 py-6 space-y-8">
          {/* Planning Settings */}
          <div>
            <h3
              className="text-[15px] uppercase tracking-wider mb-4"
              style={{ fontWeight: 500, color: 'var(--text-muted)' }}
            >
              Planning
            </h3>
            <div className="space-y-4">
              <NumberInput
                label="Target days of stock"
                value={settings.targetDays}
                onChange={(v) => onUpdateSettings({ targetDays: v })}
                min={1}
                max={365}
                suffix="days"
              />
              <NumberInput
                label="Working days per month"
                value={settings.workingDaysPerMonth}
                onChange={(v) => onUpdateSettings({ workingDaysPerMonth: v })}
                min={1}
                max={31}
                suffix="days"
              />
            </div>
          </div>

          {/* Fetch Intervals */}
          <div>
            <h3
              className="text-[15px] uppercase tracking-wider mb-4"
              style={{ fontWeight: 500, color: 'var(--text-muted)' }}
            >
              Data Refresh Intervals
            </h3>
            <div className="space-y-4">
              <NumberInput
                label="Stock on hand"
                value={settings.fetchIntervals.soh}
                onChange={(v) => onUpdateFetchIntervals({ soh: v })}
                min={1}
                max={60}
                suffix="min"
              />
              <NumberInput
                label="Assemblies"
                value={settings.fetchIntervals.assemblies}
                onChange={(v) => onUpdateFetchIntervals({ assemblies: v })}
                min={1}
                max={60}
                suffix="min"
              />
              <NumberInput
                label="Bills of material"
                value={settings.fetchIntervals.boms}
                onChange={(v) => onUpdateFetchIntervals({ boms: v })}
                min={5}
                max={120}
                suffix="min"
              />
            </div>
          </div>

          {/* Reset */}
          <div style={{ borderTop: '0.5px solid var(--border)', paddingTop: '1rem' }}>
            <button
              onClick={onResetToDefaults}
              className="w-full px-4 py-2 rounded text-lg transition hover:opacity-80"
              style={{
                color: 'var(--text-secondary)',
                background: 'var(--bg-surface)',
                border: '0.5px solid var(--border)',
              }}
            >
              Reset to Defaults
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
