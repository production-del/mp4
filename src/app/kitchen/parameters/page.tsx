'use client';

/**
 * Kitchen Parameters — editor for the dehydrator units on the calendar
 * plus per-blend equipment-type assignment.
 *
 * Scope note: the three dehydrators are interchangeable at planning time,
 * so this page does NOT let you lock a blend to a specific unit (Midgy vs
 * Mama vs Papa). Blends are only tagged with an equipment *type*
 * (dehydrator / oven / mixer). The operator chooses which physical
 * dehydrator to use at execution time by dragging a card into a lane on
 * the calendar; that choice is remembered per-batch.
 *
 * The blend list comes from `useKitchenData` so every intermediate seen in
 * Unleashed appears here — not just the ones hard-coded in the registry.
 * Equipment edits persist to `byron-kitchen-config` via `useConfig`.
 */

import { useMemo, useState } from 'react';
import { useConfig } from '../hooks/useConfig';
import { useKitchenData } from '../hooks/useKitchenData';
import { EQUIPMENT_COLORS } from '../data/intermediate-registry';
import type { IntermediateConfig, KitchenResource } from '../data/intermediate-registry';
import type { IntermediateData } from '../data/mock-data';

type Equipment = IntermediateConfig['equipment'];
const EQUIPMENT_OPTIONS: Equipment[] = ['dehydrator', 'oven', 'mixer'];

export default function KitchenParametersPage() {
  const cfg = useConfig();
  const kitchenData = useKitchenData(cfg.intermediateRegistry, {
    kitchenWarehouseId: cfg.kitchenWarehouseId,
    onWarehouseResolved: cfg.setKitchenWarehouse,
  });

  return (
    <div
      className="h-screen flex flex-col overflow-hidden"
      style={{ background: 'var(--bg-page)', color: 'var(--text-primary)' }}
    >
      {/* Header */}
      <div
        className="px-6 pt-5 pb-4 flex items-start justify-between"
        style={{ borderBottom: '0.5px solid var(--border)' }}
      >
        <div>
          <h1 className="text-xl" style={{ fontWeight: 500 }}>
            Kitchen Parameters
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Configure the dehydrator lanes shown on the calendar and tell the
            planner what equipment each blend uses. Changes save immediately.
          </p>
        </div>
        <a
          href="/kitchen"
          className="text-xs px-3 py-1.5 rounded transition hover:opacity-80 no-underline"
          style={{
            color: 'var(--text-secondary)',
            background: 'var(--bg-surface)',
            border: '0.5px solid var(--border)',
          }}
        >
          ← Back to Calendar
        </a>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-10 max-w-5xl">
        <DehydratorUnitsSection
          resources={cfg.kitchenResources}
          onChange={cfg.setKitchenResources}
        />
        <BlendEquipmentSection
          intermediates={kitchenData.intermediates}
          configMap={cfg.intermediateRegistry}
          loading={kitchenData.loading}
          onUpdateFields={cfg.updateIntermediateFields}
        />
      </div>
    </div>
  );
}

// ─── Dehydrator Units section ────────────────────────────────

/**
 * Manages the list of dehydrator units. These are the only multi-unit
 * resources in the kitchen — three run in parallel (Midgy, Mama, Papa) and
 * each one becomes a lane on the Kitchen Calendar. Ovens and mixers are
 * single-unit and don't need slot tracking.
 */
function DehydratorUnitsSection({
  resources,
  onChange,
}: {
  resources: KitchenResource[];
  onChange: (next: KitchenResource[]) => void;
}) {
  // Only dehydrator-type resources render as lanes; filter to those here.
  const units = useMemo(
    () => resources.filter((r) => r.equipment === 'dehydrator'),
    [resources]
  );

  const updateUnit = (id: string, patch: Partial<KitchenResource>) => {
    onChange(resources.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const removeUnit = (id: string, label: string) => {
    if (!confirm(`Remove unit "${label}"? Any blend currently assigned to it will become unassigned.`)) return;
    onChange(resources.filter((r) => r.id !== id));
  };

  const addNew = () => {
    let n = units.length + 1;
    let id = `dehy-${n}`;
    while (resources.some((r) => r.id === id)) {
      n += 1;
      id = `dehy-${n}`;
    }
    onChange([
      ...resources,
      { id, label: `Unit ${n}`, equipment: 'dehydrator' },
    ]);
  };

  const color = EQUIPMENT_COLORS.dehydrator;

  return (
    <section>
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h2
            className="text-sm uppercase tracking-wider"
            style={{ fontWeight: 600, color: 'var(--text-secondary)' }}
          >
            Dehydrator Units
          </h2>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Each unit becomes a lane on the Kitchen Calendar. Ovens and mixers
            are single-resource and don't need slot tracking.
          </p>
        </div>
        <button
          onClick={addNew}
          className="text-xs px-3 py-1.5 rounded text-white transition hover:opacity-85"
          style={{ background: 'var(--success)', fontWeight: 500 }}
        >
          + Add unit
        </button>
      </header>

      <div
        className="rounded overflow-hidden"
        style={{ border: '0.5px solid var(--border)' }}
      >
        <div
          className="grid px-4 py-2 text-[11px] uppercase tracking-wide"
          style={{
            gridTemplateColumns: '100px 1fr 90px',
            background: 'var(--bg-surface)',
            borderBottom: '0.5px solid var(--border)',
            color: 'var(--text-muted)',
            fontWeight: 600,
          }}
        >
          <div>ID</div>
          <div>Label</div>
          <div />
        </div>

        {units.length === 0 ? (
          <div
            className="px-4 py-6 text-sm text-center"
            style={{ color: 'var(--text-muted)', background: 'var(--bg-surface)' }}
          >
            No dehydrator units configured. Add one to start routing blends into lanes.
          </div>
        ) : (
          units.map((r, i) => (
            <div
              key={r.id}
              className="grid px-4 py-2.5 items-center text-sm"
              style={{
                gridTemplateColumns: '100px 1fr 90px',
                borderBottom:
                  i < units.length - 1
                    ? '0.5px solid var(--border)'
                    : undefined,
                background: 'var(--bg-surface)',
              }}
            >
              <div
                className="text-xs font-mono"
                style={{ color: 'var(--text-muted)' }}
                title="Stable identifier — used to link batches to this lane. Don't change once in use."
              >
                {r.id}
              </div>
              <div className="flex items-center gap-2">
                <span
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: color?.bg }}
                />
                <input
                  type="text"
                  value={r.label}
                  onChange={(e) => updateUnit(r.id, { label: e.target.value })}
                  className="px-2 py-1 rounded text-sm flex-1"
                  style={{
                    background: 'var(--bg-page)',
                    border: '0.5px solid var(--border)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>
              <button
                onClick={() => removeUnit(r.id, r.label)}
                className="text-xs px-2 py-1 rounded transition hover:opacity-80 justify-self-end"
                style={{
                  color: 'var(--danger)',
                  border: '0.5px solid var(--danger)',
                }}
              >
                Remove
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

// ─── Blend Assignments section ─────────────────────────────────

/**
 * Per-blend equipment + process editor. Shows every intermediate the planner
 * knows about (from `useKitchenData`'s merged list — Unleashed + registry
 * defaults), not just the hand-curated hardcoded ones. Each row captures:
 *
 * - Equipment type (dehydrator / oven / mixer)
 * - Run duration in days (how long it occupies its lane)
 * - Prep lead-time in days (soak, temper, …)
 * - Prep notes (free text, shown when the operator clicks a calendar card)
 *
 * The "unconfigured" chip flags blends that only exist in Unleashed and
 * haven't been explicitly set up yet — defaults are inferred but it's worth
 * reviewing them before trusting the schedule.
 */
function BlendEquipmentSection({
  intermediates,
  configMap,
  loading,
  onUpdateFields,
}: {
  intermediates: Record<string, IntermediateData>;
  configMap: Record<string, IntermediateConfig>;
  loading: boolean;
  onUpdateFields: (
    code: string,
    patch: Partial<IntermediateConfig>,
    fallback?: {
      name?: string;
      batchSize?: number;
      level?: IntermediateConfig['level'];
      equipment?: IntermediateConfig['equipment'];
    },
  ) => void;
}) {
  const [filter, setFilter] = useState('');

  // One row per distinct product code. `intermediates` is keyed by
  // assemblyId from Unleashed (so the same code can appear under multiple
  // assemblies); collapse to one entry per code, preferring configured
  // entries.
  const rows = useMemo(() => {
    const byCode = new Map<string, IntermediateData>();
    for (const item of Object.values(intermediates)) {
      if (!byCode.has(item.code)) byCode.set(item.code, item);
    }
    const list = [...byCode.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!filter.trim()) return list;
    const q = filter.trim().toLowerCase();
    return list.filter(
      (b) => b.name.toLowerCase().includes(q) || b.code.toLowerCase().includes(q),
    );
  }, [intermediates, filter]);

  const totalCount = useMemo(() => {
    const codes = new Set<string>();
    for (const item of Object.values(intermediates)) codes.add(item.code);
    return codes.size;
  }, [intermediates]);

  const configuredCount = useMemo(
    () =>
      rows.reduce(
        (n, b) => (configMap[b.code] !== undefined ? n + 1 : n),
        0,
      ),
    [rows, configMap],
  );

  return (
    <section>
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h2
            className="text-sm uppercase tracking-wider"
            style={{ fontWeight: 600, color: 'var(--text-secondary)' }}
          >
            Blend Equipment
          </h2>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            {loading && totalCount === 0
              ? 'Loading intermediates from Unleashed…'
              : `${totalCount} intermediates · ${configuredCount} explicitly configured`}
            {' · '}
            <span style={{ color: 'var(--text-muted)' }}>
              Dehydrator blends go into any of the three lanes at the operator's discretion.
            </span>
          </p>
        </div>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter blends..."
          className="text-xs px-3 py-1.5 rounded w-56"
          style={{
            background: 'var(--bg-surface)',
            border: '0.5px solid var(--border)',
            color: 'var(--text-primary)',
          }}
        />
      </header>

      {/* Two-row-per-blend layout: headline (equipment + timings) above,
          free-form prep notes below. Input widths are compact so the whole
          table fits on a standard laptop without horizontal scrolling. */}
      <div
        className="rounded overflow-hidden"
        style={{ border: '0.5px solid var(--border)' }}
      >
        <div
          className="grid px-4 py-2 text-[11px] uppercase tracking-wide"
          style={{
            gridTemplateColumns: '1fr 90px 150px 80px 80px',
            background: 'var(--bg-surface)',
            borderBottom: '0.5px solid var(--border)',
            color: 'var(--text-muted)',
            fontWeight: 600,
          }}
        >
          <div>Blend</div>
          <div>Code</div>
          <div>Equipment</div>
          <div title="Calendar days the batch occupies its lane">Run days</div>
          <div title="Days of prep work required before the batch starts">Prep days</div>
        </div>

        {rows.length === 0 ? (
          <div
            className="px-4 py-6 text-sm text-center"
            style={{ color: 'var(--text-muted)', background: 'var(--bg-surface)' }}
          >
            {loading && totalCount === 0
              ? 'Loading…'
              : totalCount === 0
                ? 'No intermediates found. Ensure the Kitchen Calendar has loaded first.'
                : `No blends match "${filter}".`}
          </div>
        ) : (
          rows.map((b, i) => {
            const isExplicit = configMap[b.code] !== undefined;
            const color = EQUIPMENT_COLORS[b.equipment];
            const duration = b.durationDays ?? 1;
            const prep = b.prepDays ?? 0;
            const notes = b.prepNotes ?? '';
            const fallback = { name: b.name, batchSize: b.batchSize, level: b.level, equipment: b.equipment };
            return (
              <div
                key={b.code}
                style={{
                  borderBottom:
                    i < rows.length - 1
                      ? '0.5px solid var(--border)'
                      : undefined,
                  background: 'var(--bg-surface)',
                }}
              >
                {/* Headline row */}
                <div
                  className="grid px-4 py-2.5 items-center text-sm"
                  style={{ gridTemplateColumns: '1fr 90px 150px 80px 80px' }}
                >
                  <div>
                    <div style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                      {b.name}
                    </div>
                    <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {b.level} · {b.batchSize}kg batch
                      {!isExplicit && (
                        <span
                          className="ml-2 px-1.5 py-0.5 rounded text-[10px]"
                          style={{
                            background: 'var(--bg-hover)',
                            color: 'var(--text-muted)',
                            fontWeight: 500,
                          }}
                          title="Default fields inferred — confirm to lock them in."
                        >
                          unconfigured
                        </span>
                      )}
                    </div>
                  </div>
                  <div
                    className="text-xs font-mono"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {b.code}
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: color?.bg }}
                    />
                    <select
                      value={b.equipment}
                      onChange={(e) =>
                        onUpdateFields(
                          b.code,
                          { equipment: e.target.value as Equipment },
                          fallback,
                        )
                      }
                      className="px-2 py-1 rounded text-sm flex-1"
                      style={{
                        background: 'var(--bg-page)',
                        border: `0.5px solid var(--border)`,
                        color: 'var(--text-primary)',
                      }}
                    >
                      {EQUIPMENT_OPTIONS.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  </div>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={duration}
                    onChange={(e) => {
                      const v = Math.max(1, Math.round(Number(e.target.value) || 1));
                      onUpdateFields(b.code, { durationDays: v }, fallback);
                    }}
                    className="px-2 py-1 rounded text-sm text-right w-16"
                    style={{
                      background: 'var(--bg-page)',
                      border: `0.5px solid var(--border)`,
                      color: 'var(--text-primary)',
                    }}
                  />
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={prep}
                    onChange={(e) => {
                      const v = Math.max(0, Math.round(Number(e.target.value) || 0));
                      onUpdateFields(b.code, { prepDays: v }, fallback);
                    }}
                    className="px-2 py-1 rounded text-sm text-right w-16"
                    style={{
                      background: 'var(--bg-page)',
                      border: `0.5px solid var(--border)`,
                      color: 'var(--text-primary)',
                    }}
                  />
                </div>

                {/* Prep notes row — only visible when the blend has prepDays
                    > 0 or existing notes, to avoid cluttering quick blends. */}
                {(prep > 0 || notes) && (
                  <div className="px-4 pb-3 -mt-1">
                    <label
                      className="text-[10px] uppercase tracking-wider block mb-1"
                      style={{ color: 'var(--text-muted)', fontWeight: 600 }}
                    >
                      Prep notes
                    </label>
                    <textarea
                      value={notes}
                      onChange={(e) =>
                        onUpdateFields(b.code, { prepNotes: e.target.value }, fallback)
                      }
                      rows={2}
                      placeholder="e.g., Soak overnight in filtered water, rinse before loading."
                      className="w-full px-2 py-1.5 rounded text-sm resize-none"
                      style={{
                        background: 'var(--bg-page)',
                        border: `0.5px solid var(--border)`,
                        color: 'var(--text-primary)',
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
