'use client';

import { useCallback, useMemo, useState } from 'react';
import { BatchCard } from './BatchCard';
import { EquipmentRow } from './EquipmentRow';
import type { useKitchenPlanner } from '../hooks/useKitchenPlanner';
import { type DehydratorSlot } from '../hooks/useKitchenPlanner';
import type { PackagingDeadline } from '../hooks/useConfig';
import type { KitchenResource } from '../data/intermediate-registry';
import type { RiskEvent } from '@/lib/planning/risk-events';
import { toLocalISODate } from '@/lib/planning/working-day';
import { useKitchenDataContext } from '../context/KitchenDataContext';

interface CalendarGridProps {
  calendar: ReturnType<typeof useKitchenPlanner>['calendar'];
  blockStart: Date;
  blockEnd: Date;
  packagingDeadlines: PackagingDeadline[];
  scheduledBatches: ReturnType<typeof useKitchenPlanner>['scheduledBatches'];
  draggedBatch: ReturnType<typeof useKitchenPlanner>['draggedBatch'];
  getBatchesForDate: ReturnType<typeof useKitchenPlanner>['getBatchesForDate'];
  getEquipmentOnDate: ReturnType<typeof useKitchenPlanner>['getEquipmentOnDate'];
  getFeasibilityColor: ReturnType<typeof useKitchenPlanner>['getFeasibilityColor'];
  getBatchWarnings: ReturnType<typeof useKitchenPlanner>['getBatchWarnings'];
  hasEquipmentConflict: ReturnType<typeof useKitchenPlanner>['hasEquipmentConflict'];
  onHandleDrop: (date: Date, dehydrator?: DehydratorSlot) => void;
  onBatchRemove: (batchId: string) => void;
  onBatchReschedule: (batchId: string, newDate: Date, dehydrator?: DehydratorSlot) => void;
  onBatchClick: (code: string) => void;
  riskEvents?: RiskEvent[];
  /** Configured kitchen resources — one lane per entry. Edit on `/kitchen/parameters`. */
  kitchenResources: KitchenResource[];
  /**
   * When set, batches whose feasibility colour doesn't match are rendered at
   * reduced opacity so operators can focus on (e.g.) only the red infeasible
   * batches while keeping everything else on screen for context.
   */
  feasibilityFilter?: 'green' | 'amber' | 'red' | null;
}

/**
 * Fixed cell height. Each cell is split into a flexible main area (scrolls
 * if too many unassigned batches) and a fixed-height lane strip at the
 * bottom for dehydrator units. Locking the height prevents one overloaded
 * lane from inflating the whole table row, which was causing cells to lose
 * vertical alignment and cards to appear to overlap.
 */
const CELL_HEIGHT = 486; // 374 × 1.3
const LANE_STRIP_HEIGHT = 221; // 170 × 1.3

/** Get the Monday of the ISO week containing `date`. */
function getMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun 1=Mon … 6=Sat
  const diff = day === 0 ? -6 : 1 - day; // offset to Monday
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function CalendarGrid({
  calendar,
  blockStart,
  blockEnd,
  packagingDeadlines,
  scheduledBatches,
  draggedBatch,
  getBatchesForDate,
  getEquipmentOnDate,
  getFeasibilityColor,
  getBatchWarnings,
  hasEquipmentConflict,
  onHandleDrop,
  onBatchRemove,
  onBatchReschedule,
  onBatchClick,
  riskEvents = [],
  kitchenResources,
  feasibilityFilter,
}: CalendarGridProps) {
  // Build weeks aligned to real Mon–Fri columns.
  // Each week is a 5-element tuple: [Mon, Tue, Wed, Thu, Fri]
  // where each slot is Date | null (null = holiday or outside range).
  const [weeks, workingDays] = useMemo(() => {
    const weekMap = new Map<string, (Date | null)[]>();
    const working: Date[] = [];

    let current = new Date(blockStart);

    while (current <= blockEnd) {
      const dow = current.getDay(); // 0=Sun … 6=Sat

      if (dow >= 1 && dow <= 5) {
        // Weekday — find which column (0=Mon … 4=Fri)
        const colIdx = dow - 1;
        const monday = getMonday(current);
        const weekKey = toLocalISODate(monday);

        if (!weekMap.has(weekKey)) {
          weekMap.set(weekKey, [null, null, null, null, null]);
        }

        const slot = weekMap.get(weekKey)!;

        if (calendar.isWorkingDay(current)) {
          slot[colIdx] = new Date(current);
          working.push(new Date(current));
        }
        // holidays leave null — renders as greyed-out cell
      }

      current.setDate(current.getDate() + 1);
    }

    // Sort by week key (chronological) and extract arrays
    const sorted = [...weekMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, days]) => days);

    return [sorted, working];
  }, [blockStart, blockEnd, calendar]);

  const getPackagingDeadline = useCallback(
    (date: Date) => {
      const dateStr = toLocalISODate(date);
      return packagingDeadlines.find((d) => d.date === dateStr);
    },
    [packagingDeadlines]
  );

  const { intermediates } = useKitchenDataContext();

  // Build a lookup: batchId → most recent RiskEvent affecting it
  const riskByBatch = useMemo(() => {
    const map = new Map<string, RiskEvent>();
    for (const event of riskEvents) {
      for (const batchId of event.affectedBatchIds) {
        // Later events overwrite earlier ones (most recent wins)
        map.set(batchId, event);
      }
    }
    return map;
  }, [riskEvents]);

  const [dragOverDate, setDragOverDate] = useState<string | null>(null);
  const [dragOverSlot, setDragOverSlot] = useState<DehydratorSlot | null>(null);

  // Highlight the hovered cell / slot whenever a drag is in progress — both
  // pool drags (draggedBatch set) and calendar reschedules (batchId on
  // dataTransfer). `dragover` only fires during an active drag, so no gating
  // is needed. Without this, reschedules had zero visual feedback.
  const handleDragOver = (e: React.DragEvent, date: Date, slot?: DehydratorSlot) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDragOverDate(toLocalISODate(date));
    setDragOverSlot(slot ?? null);
  };

  // HTML5 `dragleave` fires when the cursor enters a *child* element (e.g.
  // the lane's label or an existing batch card inside it), even though the
  // cursor is still within the drop zone. That caused the highlight to
  // flicker and occasional "dropped on nothing" failures mid-release.
  // `relatedTarget` is the element being entered — if it's still a
  // descendant of currentTarget, the cursor hasn't really left. Ignore.
  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    const related = e.relatedTarget as Node | null;
    if (related && e.currentTarget.contains(related)) return;
    setDragOverDate(null);
    setDragOverSlot(null);
  };

  const handleDrop = (e: React.DragEvent, date: Date, slot?: DehydratorSlot) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverDate(null);
    setDragOverSlot(null);
    // Check if this is a reschedule of an existing batch
    const batchId = e.dataTransfer.getData('batchId');

    // Lanes (Midgy/Mama/Papa) are dehydrator-only. If the dropped batch is
    // an oven/mixer assembly, ignore the lane assignment so it lands in the
    // main cell area instead of occupying a dehydrator slot.
    let effectiveSlot = slot;
    if (slot) {
      let equipment: string | undefined;
      if (batchId) {
        const batch = scheduledBatches.find((b) => b.id === batchId);
        if (batch) equipment = intermediates[batch.intermediateKey]?.equipment;
      } else if (draggedBatch) {
        equipment = intermediates[draggedBatch.intermediateCode]?.equipment;
      }
      if (equipment && equipment !== 'dehydrator') {
        effectiveSlot = undefined;
      }
    }

    if (batchId) {
      onBatchReschedule(batchId, date, effectiveSlot);
    } else {
      onHandleDrop(date, effectiveSlot);
    }
  };

  const handleBatchDragStart = (
    e: React.DragEvent,
    batch: (typeof scheduledBatches)[0]
  ) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('batchId', batch.id);
  };

  /**
   * Resolve which resource lane a batch belongs in. The three dehydrator
   * units are interchangeable at planning time, so there's no blend-level
   * default — batches only land in a specific lane after an operator drags
   * them there (which writes `batch.dehydrator`). Until then they sit in
   * the main cell area.
   */
  const getBatchResource = useCallback((batch: (typeof scheduledBatches)[0]): string | undefined => {
    return batch.dehydrator;
  }, []);

  /**
   * For a given (date, laneId), find all batches physically occupying that
   * lane — including continuations of multi-day batches that started earlier.
   * A batch with `durationDays: 2` starting Monday occupies Mon + Tue of its
   * assigned lane; Tuesday's cell renders it as dayIndex=1 (continuation).
   * Calendar days, not working days — dehydrators run through the weekend.
   */
  const getLaneOccupations = useCallback(
    (date: Date, laneId: string) => {
      const dayMs = 1000 * 60 * 60 * 24;
      const target = new Date(date);
      target.setHours(0, 0, 0, 0);
      const result: { batch: (typeof scheduledBatches)[0]; dayIndex: number; durationDays: number }[] = [];
      for (const batch of scheduledBatches) {
        if (batch.dehydrator !== laneId) continue;
        const intermediate = intermediates[batch.intermediateKey];
        // Lanes are dehydrator-only — skip any oven/mixer batch with a stale
        // lane assignment so it falls back to the main cell area.
        if (intermediate && intermediate.equipment !== 'dehydrator') continue;
        const durationDays = Math.max(1, intermediate?.durationDays ?? 1);
        const start = new Date(batch.scheduledDate);
        start.setHours(0, 0, 0, 0);
        const diff = Math.round((target.getTime() - start.getTime()) / dayMs);
        if (diff >= 0 && diff < durationDays) {
          result.push({ batch, dayIndex: diff, durationDays });
        }
      }
      return result;
    },
    [scheduledBatches, intermediates],
  );

  // Only dehydrators get lanes — they're the multi-unit resources where
  // physical-slot assignment matters. Oven and mixer resources (if present)
  // are treated as "no lane" and their batches fall through to the main
  // area. This is defensive against old persisted configs that seeded non-
  // dehydrator defaults before this decision was made.
  const laneResources = useMemo(
    () => kitchenResources.filter((r) => r.equipment === 'dehydrator'),
    [kitchenResources]
  );

  // Valid lane ids — used to guard against stale assignments referring
  // to a resource that's since been deleted or demoted to non-lane.
  const resourceIds = useMemo(
    () => new Set(laneResources.map((r) => r.id)),
    [laneResources]
  );

  return (
    <div className="flex-1 overflow-auto flex flex-col" style={{ background: 'var(--bg-page)' }}>
      {/* Calendar table */}
      <div className="flex-1 overflow-auto">
        <table className="border-collapse w-full table-fixed">
          <colgroup>
            <col className="w-12" />
            <col /><col /><col /><col /><col />
          </colgroup>
          <thead className="sticky top-0 z-10" style={{ background: 'var(--bg-surface)' }}>
            <tr>
              <th
                className="p-2 text-left text-xs"
                style={{ fontWeight: 500, color: 'var(--text-muted)', background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }}
              >
                Week
              </th>
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((day) => (
                <th
                  key={day}
                  className="p-3 text-center text-sm"
                  style={{ fontWeight: 500, color: 'var(--text-primary)', background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }}
                >
                  {day}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week, weekIndex) => (
              <tr key={weekIndex} style={{ height: CELL_HEIGHT }}>
                <td
                  className="p-1 text-center text-xs"
                  style={{ fontWeight: 500, color: 'var(--text-muted)', background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }}
                >
                  WK {weekIndex + 1}
                </td>
                {week.map((date, colIndex) => {
                  // Null = public holiday or outside block range
                  if (!date) {
                    return (
                      <td
                        key={`empty-${colIndex}`}
                        style={{ padding: 4, verticalAlign: 'top', background: 'var(--bg-page)', height: CELL_HEIGHT }}
                      >
                        <div
                          className="rounded"
                          style={{
                            height: CELL_HEIGHT - 8,
                            border: '1px solid var(--border)',
                            background: 'var(--bg-surface)',
                            opacity: 0.4,
                          }}
                        />
                      </td>
                    );
                  }

                  const dateStr = toLocalISODate(date);
                  const isNow = dragOverDate === dateStr;
                  const batches = getBatchesForDate(date);
                  const deadline = getPackagingDeadline(date);
                  const equipConflict = hasEquipmentConflict(date);

                  // Cell background
                  let cellBg = 'var(--bg-page)';
                  let cellBorder = 'var(--border)';
                  if (isNow) {
                    cellBg = 'var(--accent-light)';
                    cellBorder = 'var(--accent)';
                  } else if (equipConflict) {
                    cellBg = 'var(--warning-light)';
                    cellBorder = 'var(--warning)';
                  }

                  // Main area shows batches with no lane assignment (and any
                  // with a stale assignment referring to a removed lane).
                  // Lane occupants (including multi-day continuations) are
                  // computed per-lane below via `getLaneOccupations`.
                  const mainBatches = batches.filter((b) => {
                    const res = getBatchResource(b);
                    if (!res || !resourceIds.has(res)) return true;
                    // Non-dehydrator batches never occupy a lane — show them in
                    // the main area even if they carry a stale lane assignment.
                    const equipment = intermediates[b.intermediateKey]?.equipment;
                    return equipment !== undefined && equipment !== 'dehydrator';
                  });
                  const isMainDragOver = isNow && !dragOverSlot;

                  return (
                    <td
                      key={dateStr}
                      className="transition cursor-default"
                      style={{ padding: 4, verticalAlign: 'top', background: 'var(--bg-page)', height: CELL_HEIGHT }}
                    >
                      {/* Day card — thick outer border makes it obvious the
                          main area + dehydrator lanes belong to the same day.
                          Fixed height keeps all cells aligned; overflow hidden
                          clips internal sections so their scrollbars sit
                          inside the day boundary. */}
                      <div
                        className="flex flex-col rounded overflow-hidden transition"
                        style={{
                          height: CELL_HEIGHT - 8,
                          border: `1.5px solid ${cellBorder}`,
                          background: cellBg,
                        }}
                      >
                      <div
                        className="p-2 pb-1 overflow-y-auto"
                        style={{
                          background: isMainDragOver ? 'var(--accent-light)' : undefined,
                          flex: '1 1 auto',
                          minHeight: 0,
                        }}
                        onDragOver={(e) => handleDragOver(e, date)}
                        onDragLeave={handleDragLeave}
                        onDrop={(e) => handleDrop(e, date)}
                      >
                        {/* Date label + equipment conflict indicator */}
                        <div className="flex items-center justify-between mb-1">
                          <div className="text-xs" style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>
                            {date.toLocaleDateString('en-AU', {
                              month: 'short',
                              day: 'numeric',
                            })}
                          </div>
                          {equipConflict && (
                            <span
                              className="text-xs"
                              style={{ fontWeight: 500, color: 'var(--warning)' }}
                              title="Equipment conflict on this day"
                            >
                              ! equip
                            </span>
                          )}
                        </div>

                        {/* Packaging deadline anchor */}
                        {deadline && (
                          <div
                            className="mb-1 p-1.5 rounded text-xs"
                            style={{
                              fontWeight: 500,
                              color: 'var(--purple)',
                              background: 'var(--purple-light)',
                              border: '1px dashed var(--purple-border)',
                            }}
                          >
                            {deadline.label}
                          </div>
                        )}

                        {/* Batches without a resource assignment. Drag one
                            into a lane below to assign it. */}
                        <div className="space-y-1">
                          {mainBatches.map((batch) => {
                            const warnings = getBatchWarnings(batch.id);
                            const isUnleashed = batch.origin === 'unleashed';
                            // When a stat-card filter is active, dim batches
                            // whose feasibility colour doesn't match so the
                            // operator's eye goes straight to the ones they
                            // clicked the card for.
                            const dimByFilter = feasibilityFilter != null && getFeasibilityColor(batch.id) !== feasibilityFilter;
                            return (
                              <div
                                key={batch.id}
                                draggable
                                onDragStart={(e) => handleBatchDragStart(e, batch)}
                                className="group relative"
                                style={{ opacity: dimByFilter ? 0.25 : 1, transition: 'opacity 120ms ease' }}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  onBatchRemove(batch.id);
                                }}
                              >
                                <BatchCard
                                  intermediateKey={batch.intermediateKey}
                                  batchId={batch.id}
                                  batchQuantity={batch.quantity}
                                  variant="calendar"
                                  feasibilityColor={getFeasibilityColor(batch.id)}
                                  warnings={warnings}
                                  isUnleashed={isUnleashed}
                                  riskEvent={riskByBatch.get(batch.id)}
                                  onClick={() => onBatchClick(batch.intermediateKey)}
                                />
                                <button
                                  className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 text-white rounded px-1 py-0 text-xs transition"
                                  style={{ background: 'var(--danger)' }}
                                  onClick={() => onBatchRemove(batch.id)}
                                  title={isUnleashed ? 'Hide from calendar (stays in sidebar)' : 'Remove from calendar'}
                                >
                                  x
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      {/* Resource lanes — one per configured kitchen resource.
                          Anchored to the bottom of the cell; each lane scrolls
                          internally so no single overloaded lane can inflate
                          the whole row. Edit the list on /kitchen/parameters. */}
                      <div
                        className="flex gap-px"
                        style={{
                          borderTop: '0.5px solid var(--border)',
                          background: 'var(--border)',
                          flexShrink: 0,
                          height: LANE_STRIP_HEIGHT,
                        }}
                      >
                        {laneResources.map((slot) => {
                          // Occupations = batches physically occupying this
                          // lane on this day, including multi-day batches that
                          // started earlier. `dayIndex === 0` is the start
                          // (render full card); `dayIndex > 0` is a continuation
                          // (render a compact strip).
                          const occupations = getLaneOccupations(date, slot.id);
                          const isSlotDragOver = isNow && dragOverSlot === slot.id;
                          return (
                            <div
                              key={slot.id}
                              className="flex-1 p-1.5 transition flex flex-col overflow-hidden"
                              style={{
                                background: isSlotDragOver ? 'var(--accent-light)' : 'var(--bg-surface)',
                                border: isSlotDragOver ? '1px solid var(--accent)' : '1px solid transparent',
                              }}
                              onDragOver={(e) => handleDragOver(e, date, slot.id)}
                              onDragLeave={handleDragLeave}
                              onDrop={(e) => handleDrop(e, date, slot.id)}
                            >
                              <div
                                className="text-center mb-0.5 flex-shrink-0"
                                style={{
                                  fontSize: '9px',
                                  fontWeight: 600,
                                  color: 'var(--text-muted)',
                                  letterSpacing: '0.03em',
                                  textTransform: 'uppercase',
                                }}
                              >
                                {slot.label}
                              </div>
                              {occupations.length > 0 ? (
                                <div
                                  className="space-y-1 overflow-y-auto"
                                  style={{ flex: '1 1 auto', minHeight: 0 }}
                                >
                                  {occupations.map(({ batch: slotBatch, dayIndex, durationDays }) => {
                                    const isUnleashed = slotBatch.origin === 'unleashed';
                                    const dimByFilter = feasibilityFilter != null && getFeasibilityColor(slotBatch.id) !== feasibilityFilter;
                                    // Day 1 — full card. The operator can drag
                                    // it to a different day/lane from here.
                                    if (dayIndex === 0) {
                                      return (
                                        <div
                                          key={slotBatch.id}
                                          draggable
                                          onDragStart={(e) => handleBatchDragStart(e, slotBatch)}
                                          className="group relative"
                                          style={{ opacity: dimByFilter ? 0.25 : 1, transition: 'opacity 120ms ease' }}
                                          onContextMenu={(e) => {
                                            e.preventDefault();
                                            onBatchRemove(slotBatch.id);
                                          }}
                                        >
                                          <BatchCard
                                            intermediateKey={slotBatch.intermediateKey}
                                            batchId={slotBatch.id}
                                            batchQuantity={slotBatch.quantity}
                                            variant="calendar"
                                            feasibilityColor={getFeasibilityColor(slotBatch.id)}
                                            warnings={getBatchWarnings(slotBatch.id)}
                                            isUnleashed={isUnleashed}
                                            riskEvent={riskByBatch.get(slotBatch.id)}
                                            onClick={() => onBatchClick(slotBatch.intermediateKey)}
                                          />
                                          {durationDays > 1 && (
                                            <span
                                              className="absolute top-1 right-1 text-[9px] px-1 py-0.5 rounded"
                                              style={{
                                                background: 'var(--bg-surface)',
                                                color: 'var(--text-muted)',
                                                fontWeight: 500,
                                                border: '0.5px solid var(--border)',
                                              }}
                                              title={`Occupies this unit for ${durationDays} days`}
                                            >
                                              {durationDays}d
                                            </span>
                                          )}
                                          <button
                                            className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 text-white rounded px-0.5 text-[9px] transition"
                                            style={{ background: 'var(--danger)' }}
                                            onClick={() => onBatchRemove(slotBatch.id)}
                                            title={isUnleashed ? 'Hide from calendar (stays in sidebar)' : 'Remove from calendar'}
                                          >
                                            x
                                          </button>
                                        </div>
                                      );
                                    }
                                    // Continuation day — compact strip so the
                                    // operator sees the unit is still busy
                                    // without re-reading the full batch card.
                                    const color = getFeasibilityColor(slotBatch.id);
                                    const colorMap = {
                                      green: { bg: 'var(--success-light)', border: 'var(--success)' },
                                      amber: { bg: 'var(--warning-light)', border: 'var(--warning)' },
                                      red: { bg: 'var(--danger-light)', border: 'var(--danger)' },
                                    } as const;
                                    const c = colorMap[color];
                                    return (
                                      <div
                                        key={`${slotBatch.id}-d${dayIndex}`}
                                        onClick={() => onBatchClick(slotBatch.intermediateKey)}
                                        className="rounded px-2 py-1 text-[10px] cursor-pointer flex items-center gap-1 hover:opacity-85 transition"
                                        style={{
                                          background: c.bg,
                                          borderLeft: `3px solid ${c.border}`,
                                          color: 'var(--text-secondary)',
                                          opacity: 0.75,
                                        }}
                                        title={`${slotBatch.productCode} — day ${dayIndex + 1} of ${durationDays} (started ${new Date(slotBatch.scheduledDate).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })})`}
                                      >
                                        <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                                          {slotBatch.productCode}
                                        </span>
                                        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>
                                          {dayIndex + 1}/{durationDays}
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                      </div>

                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Equipment row */}
      <div className="p-3" style={{ borderTop: '0.5px solid var(--border)', background: 'var(--bg-surface)' }}>
        <div className="text-xs mb-3" style={{ fontWeight: 500, color: 'var(--text-muted)' }}>Equipment</div>
        <div className="space-y-2 max-h-32 overflow-y-auto">
          {workingDays.map((date) => (
            <EquipmentRow
              key={date.toISOString()}
              date={date}
              getEquipmentOnDate={getEquipmentOnDate}
              scheduledBatches={scheduledBatches}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
