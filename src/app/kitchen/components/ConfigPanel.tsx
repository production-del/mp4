'use client';

import { useState } from 'react';
import type { useConfig } from '../hooks/useConfig';
import { EQUIPMENT_OPTIONS } from '../hooks/useConfig';
import type { IntermediateConfig } from '../data/intermediate-registry';

type ConfigHook = ReturnType<typeof useConfig>;

interface ConfigPanelProps {
  config: ConfigHook['config'];
  onSetBlockDates: ConfigHook['setBlockDates'];
  onUpdateIntermediate: ConfigHook['updateIntermediate'];
  onRemoveIntermediate: ConfigHook['removeIntermediate'];
  onSetPackagingDeadlines: ConfigHook['setPackagingDeadlines'];
  onResetToDefaults: ConfigHook['resetToDefaults'];
  onClose: () => void;
}

export function ConfigPanel({
  config,
  onSetBlockDates,
  onUpdateIntermediate,
  onRemoveIntermediate,
  onSetPackagingDeadlines,
  onResetToDefaults,
  onClose,
}: ConfigPanelProps) {
  const [activeTab, setActiveTab] = useState<'block' | 'intermediates' | 'deadlines'>('block');

  return (
    <div
      className="fixed inset-0 bg-black/30 flex justify-end z-50"
      onClick={onClose}
    >
      <div
        className="w-[560px] h-full overflow-y-auto"
        style={{ background: 'var(--bg-page)', borderLeft: '0.5px solid var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="sticky top-0 px-6 py-4 flex items-center justify-between z-10"
          style={{ background: 'var(--bg-page)', borderBottom: '0.5px solid var(--border)' }}
        >
          <h2 className="text-lg" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>Settings</h2>
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                onResetToDefaults();
              }}
              className="px-3 py-1.5 text-xs rounded transition hover:opacity-70"
              style={{ color: 'var(--text-muted)', border: '0.5px solid var(--border)', fontWeight: 400 }}
            >
              Reset defaults
            </button>
            <button
              onClick={onClose}
              className="text-xl transition hover:opacity-60"
              style={{ color: 'var(--text-muted)' }}
            >
              x
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex" style={{ borderBottom: '0.5px solid var(--border)' }}>
          {[
            { key: 'block' as const, label: 'Block Dates' },
            { key: 'intermediates' as const, label: 'Intermediates' },
            { key: 'deadlines' as const, label: 'Deadlines' },
          ].map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className="flex-1 px-4 py-3 text-sm transition"
              style={{
                fontWeight: activeTab === tab.key ? 500 : 400,
                color: activeTab === tab.key ? 'var(--accent)' : 'var(--text-muted)',
                borderBottom: activeTab === tab.key ? '2px solid var(--accent)' : '2px solid transparent',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="p-6">
          {activeTab === 'block' && (
            <BlockDatesTab
              blockStart={config.blockStart}
              blockEnd={config.blockEnd}
              onSave={onSetBlockDates}
            />
          )}
          {activeTab === 'intermediates' && (
            <IntermediatesTab
              intermediates={config.intermediates}
              onUpdate={onUpdateIntermediate}
              onRemove={onRemoveIntermediate}
            />
          )}
          {activeTab === 'deadlines' && (
            <DeadlinesTab
              deadlines={config.packagingDeadlines}
              onSave={onSetPackagingDeadlines}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Block Dates Tab ----

function BlockDatesTab({
  blockStart,
  blockEnd,
  onSave,
}: {
  blockStart: string;
  blockEnd: string;
  onSave: (start: string, end: string) => void;
}) {
  const [start, setStart] = useState(blockStart);
  const [end, setEnd] = useState(blockEnd);

  return (
    <div className="space-y-4">
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        The 4-week planning window for this production block.
      </p>
      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <span className="text-xs" style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>Block Start</span>
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="mt-1 w-full rounded px-3 py-2 text-sm focus:outline-none"
            style={{ color: 'var(--text-primary)', background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }}
          />
        </label>
        <label className="block">
          <span className="text-xs" style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>Block End</span>
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="mt-1 w-full rounded px-3 py-2 text-sm focus:outline-none"
            style={{ color: 'var(--text-primary)', background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }}
          />
        </label>
      </div>
      <button
        onClick={() => onSave(start, end)}
        className="px-4 py-2 rounded text-sm text-white transition"
        style={{ fontWeight: 500, background: 'var(--accent)' }}
      >
        Save
      </button>
    </div>
  );
}

// ---- Intermediates Tab ----

const EMPTY_INTERMEDIATE: IntermediateConfig = {
  code: '',
  name: '',
  level: 'top',
  batchSize: 100,
  equipment: 'oven',
  requires: [],
};

function IntermediatesTab({
  intermediates,
  onUpdate,
  onRemove,
}: {
  intermediates: Record<string, IntermediateConfig>;
  onUpdate: (code: string, data: IntermediateConfig) => void;
  onRemove: (code: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<IntermediateConfig>(EMPTY_INTERMEDIATE);
  const [isNew, setIsNew] = useState(false);

  const startEdit = (code: string) => {
    setEditing(code);
    setDraft({ ...intermediates[code] });
    setIsNew(false);
  };

  const startNew = () => {
    setEditing('__new__');
    setDraft({ ...EMPTY_INTERMEDIATE });
    setIsNew(true);
  };

  const save = () => {
    if (!draft.code.trim() || !draft.name.trim()) return;
    onUpdate(draft.code, draft);
    setEditing(null);
  };

  const cancel = () => setEditing(null);

  const allCodes = Object.keys(intermediates);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          {allCodes.length} intermediates configured
        </p>
        <button
          onClick={startNew}
          className="px-3 py-1.5 rounded text-xs text-white transition"
          style={{ fontWeight: 500, background: 'var(--success)' }}
        >
          + Add
        </button>
      </div>

      {/* Edit form */}
      {editing && (
        <IntermediateForm
          draft={draft}
          setDraft={setDraft}
          isNew={isNew}
          allCodes={allCodes}
          onSave={save}
          onCancel={cancel}
        />
      )}

      {/* List */}
      <div className="space-y-2">
        {Object.entries(intermediates).map(([key, item]) => (
          <div
            key={key}
            className="flex items-center justify-between p-3 rounded transition"
            style={{
              border: `0.5px solid ${editing === item.code ? 'var(--accent)' : 'var(--border)'}`,
              background: editing === item.code ? 'var(--accent-light)' : 'var(--bg-surface)',
            }}
          >
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                  {item.name}
                </span>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{item.code}</span>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{
                    fontWeight: 500,
                    background: item.level === 'secondary' ? 'var(--purple-light)' : 'var(--bg-hover)',
                    color: item.level === 'secondary' ? 'var(--purple)' : 'var(--text-secondary)',
                  }}
                >
                  {item.level}
                </span>
              </div>
              <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                {item.batchSize}kg . {item.equipment}
                {item.requires.length > 0 &&
                  ` . requires ${item.requires.join(', ')}`}
              </div>
            </div>
            <div className="flex items-center gap-2 ml-3">
              <button
                onClick={() => startEdit(item.code)}
                className="px-2 py-1 text-xs rounded transition hover:opacity-70"
                style={{ color: 'var(--text-secondary)', border: '0.5px solid var(--border)' }}
              >
                Edit
              </button>
              <button
                onClick={() => onRemove(item.code)}
                className="px-2 py-1 text-xs rounded transition hover:opacity-70"
                style={{ color: 'var(--danger)', border: '0.5px solid var(--danger)' }}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function IntermediateForm({
  draft,
  setDraft,
  isNew,
  allCodes,
  onSave,
  onCancel,
}: {
  draft: IntermediateConfig;
  setDraft: (d: IntermediateConfig) => void;
  isNew: boolean;
  allCodes: string[];
  onSave: () => void;
  onCancel: () => void;
}) {
  const [requiresInput, setRequiresInput] = useState(draft.requires.join(', '));

  return (
    <div
      className="rounded p-4 space-y-3"
      style={{ background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }}
    >
      <div className="text-[11px] uppercase tracking-wide" style={{ fontWeight: 500, color: 'var(--text-muted)' }}>
        {isNew ? 'New Intermediate' : `Editing ${draft.code}`}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Code</span>
          <input
            value={draft.code}
            onChange={(e) =>
              setDraft({ ...draft, code: e.target.value.toUpperCase() })
            }
            disabled={!isNew}
            placeholder="e.g. IGC"
            className="mt-1 w-full rounded px-2 py-1.5 text-sm focus:outline-none disabled:opacity-50"
            style={{ color: 'var(--text-primary)', background: 'var(--bg-page)', border: '0.5px solid var(--border)' }}
          />
        </label>
        <label className="block">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Name</span>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="e.g. Cacao Granola"
            className="mt-1 w-full rounded px-2 py-1.5 text-sm focus:outline-none"
            style={{ color: 'var(--text-primary)', background: 'var(--bg-page)', border: '0.5px solid var(--border)' }}
          />
        </label>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <label className="block">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Level</span>
          <select
            value={draft.level}
            onChange={(e) =>
              setDraft({
                ...draft,
                level: e.target.value as 'top' | 'secondary',
              })
            }
            className="mt-1 w-full rounded px-2 py-1.5 text-sm focus:outline-none"
            style={{ color: 'var(--text-primary)', background: 'var(--bg-page)', border: '0.5px solid var(--border)' }}
          >
            <option value="top">Top</option>
            <option value="secondary">Secondary</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Batch Size (kg)</span>
          <input
            type="number"
            value={draft.batchSize}
            onChange={(e) =>
              setDraft({ ...draft, batchSize: Number(e.target.value) })
            }
            className="mt-1 w-full rounded px-2 py-1.5 text-sm focus:outline-none"
            style={{ color: 'var(--text-primary)', background: 'var(--bg-page)', border: '0.5px solid var(--border)' }}
          />
        </label>
        <label className="block">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Equipment</span>
          <select
            value={draft.equipment}
            onChange={(e) =>
              setDraft({
                ...draft,
                equipment: e.target.value as IntermediateConfig['equipment'],
              })
            }
            className="mt-1 w-full rounded px-2 py-1.5 text-sm focus:outline-none"
            style={{ color: 'var(--text-primary)', background: 'var(--bg-page)', border: '0.5px solid var(--border)' }}
          >
            {EQUIPMENT_OPTIONS.map((eq) => (
              <option key={eq} value={eq}>
                {eq}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block">
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Requires (comma-separated codes)
        </span>
        <input
          value={requiresInput}
          onChange={(e) => {
            setRequiresInput(e.target.value);
            const codes = e.target.value
              .split(',')
              .map((s) => s.trim().toUpperCase())
              .filter(Boolean);
            setDraft({ ...draft, requires: codes });
          }}
          placeholder="e.g. IAA, IAB"
          className="mt-1 w-full rounded px-2 py-1.5 text-sm focus:outline-none"
          style={{ color: 'var(--text-primary)', background: 'var(--bg-page)', border: '0.5px solid var(--border)' }}
        />
      </label>

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onSave}
          disabled={!draft.code.trim() || !draft.name.trim()}
          className="px-3 py-1.5 rounded text-xs text-white transition disabled:opacity-30 disabled:cursor-not-allowed"
          style={{ fontWeight: 500, background: 'var(--accent)' }}
        >
          Save
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-xs transition hover:opacity-70"
          style={{ color: 'var(--text-muted)' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---- Deadlines Tab ----

function DeadlinesTab({
  deadlines,
  onSave,
}: {
  deadlines: Array<{ date: string; label: string }>;
  onSave: (d: Array<{ date: string; label: string }>) => void;
}) {
  const [items, setItems] = useState(deadlines);

  const update = (index: number, field: 'date' | 'label', value: string) => {
    const next = [...items];
    next[index] = { ...next[index], [field]: value };
    setItems(next);
  };

  const add = () => {
    setItems([...items, { date: '', label: '' }]);
  };

  const remove = (index: number) => {
    setItems(items.filter((_, i) => i !== index));
  };

  const save = () => {
    // Filter out empty rows and sort by date
    const clean = items
      .filter((d) => d.date && d.label)
      .sort((a, b) => a.date.localeCompare(b.date));
    setItems(clean);
    onSave(clean);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        Packaging run dates that appear as fixed anchors on the calendar.
      </p>

      <div className="space-y-2">
        {items.map((d, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              type="date"
              value={d.date}
              onChange={(e) => update(i, 'date', e.target.value)}
              className="rounded px-2 py-1.5 text-sm focus:outline-none"
              style={{ color: 'var(--text-primary)', background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }}
            />
            <input
              value={d.label}
              onChange={(e) => update(i, 'label', e.target.value)}
              placeholder="e.g. Walnuts ME+LG"
              className="flex-1 rounded px-2 py-1.5 text-sm focus:outline-none"
              style={{ color: 'var(--text-primary)', background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }}
            />
            <button
              onClick={() => remove(i)}
              className="px-2 py-1 text-sm transition hover:opacity-70"
              style={{ color: 'var(--danger)' }}
            >
              x
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={add}
          className="px-3 py-1.5 rounded text-xs transition hover:opacity-70"
          style={{ color: 'var(--text-secondary)', border: '0.5px solid var(--border)', fontWeight: 500 }}
        >
          + Add Deadline
        </button>
        <button
          onClick={save}
          className="px-4 py-2 rounded text-sm text-white transition"
          style={{ fontWeight: 500, background: 'var(--accent)' }}
        >
          Save
        </button>
      </div>
    </div>
  );
}
