'use client';

import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import type { PackagingSKU, ProductFamily } from '../hooks/usePackagingData';
import {
  PACKING_TEAMS, TEAM_LABELS, TEAM_COLORS,
  type PackingTeam,
} from '../hooks/usePackagingPlanner';
import { dayIntToDate, dateToDayInt, formatDayInt } from '@/lib/planning/working-day';
import { computePackagingFeasibility } from '@/lib/planning/packaging-feasibility';

// ─── Types ──────────────────────────────────────────────────

/**
 * `source` discriminates "newly planned in this session" from entries that
 * mirror an Unleashed assembly record. Existing-live cards are styled with a
 * live-bar, show the assembly number, and can still be dragged (doing so
 * records an UPDATE edit against the existing assembly).
 */
type AssemblySource = 'planned' | 'existing';

/**
 * Three-state feasibility matching the kitchen calendar:
 *   • `green`  — intermediate + labels already at MF Packaging in sufficient qty
 *   • `amber`  — sufficient globally, but requires a warehouse transfer
 *   • `red`    — insufficient globally (requires fresh production or PO)
 */
type CardFeasibility = 'green' | 'amber' | 'red';

interface CalendarAssembly {
  productCode: string;
  productName: string;
  familyCode: string;
  familyName: string;
  sizeVariant: string;
  quantity: number;
  dayInt: number;
  team?: PackingTeam;
  suggestedQty: number;
  kgPerUnit: number;
  /**
   * Days of cover remaining for this SKU at current sales rate. Used to
   * order cells by urgency (lowest = closest to stockout = packed first).
   * `Infinity` when there's no monthly usage data for the SKU.
   */
  daysAvailable: number;
  source: AssemblySource;
  /** Present for `existing` entries; displayed on the card for reference. */
  assemblyNumber?: string;
  /** True when the user has moved/edited this existing entry this session. */
  pendingUpdate?: boolean;
  feasibility: CardFeasibility;
  /** Which constraint bit the red/amber — for the card tooltip. */
  feasibilityReason?: string;
}

/**
 * Compute feasibility for a single assembly based on SOH snapshot.
 *
 * Runs per-card (no forward simulation across cards yet). A family with
 * competing runs may show multiple greens even when aggregate demand exceeds
 * supply — the family feasibility footer catches that case.
 */
/** Thin wrapper that passes the SKU fields through to the shared engine. */
function computeFeasibility(
  sku: PackagingSKU,
  quantity: number,
): { state: CardFeasibility; reason?: string } {
  return computePackagingFeasibility(sku, quantity);
}

/** Card colour palette — matches the kitchen calendar's 3-state scheme. */
const FEASIBILITY_BG: Record<CardFeasibility, string> = {
  green: 'color-mix(in srgb, var(--success) 14%, var(--bg-surface))',
  amber: 'color-mix(in srgb, var(--warning) 14%, var(--bg-surface))',
  red: 'color-mix(in srgb, var(--danger) 16%, var(--bg-surface))',
};
const FEASIBILITY_BORDER: Record<CardFeasibility, string> = {
  green: 'var(--success)',
  amber: 'var(--warning)',
  red: 'var(--danger)',
};

interface PackagingCalendarProps {
  skus: PackagingSKU[];
  families: ProductFamily[];
  getPlanned: (code: string) => { quantity: number; dayInt: number; team?: PackingTeam } | null;
  assignToCalendar: (code: string, dayInt: number, team: PackingTeam) => void;
  setPlanQty: (code: string, qty: number) => void;
  setPlanDay: (code: string, dayInt: number) => void;
  setPlanTeam: (code: string, team: PackingTeam | undefined) => void;
  fillFamilySuggestions: (familyCode: string, dayInt?: number) => void;
  /** Read current team edit for an existing assembly (undefined = unchanged). */
  getExistingTeam: (code: string) => PackingTeam | undefined;
  /** Read edited quantity for an existing assembly (null = unchanged). */
  getExistingQty: (code: string) => number | null;
  /** Read edited day-int for an existing assembly (null = unchanged). */
  getExistingDay: (code: string) => number | null;
  /** Record a move of an existing Unleashed assembly to a new (day, team) slot. */
  moveExisting: (code: string, dayInt: number, team: PackingTeam | undefined) => void;
  /**
   * Click callback that opens the BOM investigation modal for the given
   * packaging run. Owned by the page so the same modal renders for clicks
   * from both the calendar and the table view.
   */
  onOpenCardModal?: (args: {
    productCode: string;
    runQuantity?: number;
    runDayInt?: number;
    runTeam?: PackingTeam;
  }) => void;
}

// ─── Helpers ────────────────────────────────────────────────

/** Build dayInts for a given week offset (0 = current week). */
function weekDayInts(weekOffset: number): number[] {
  const base = weekOffset * 5;
  return [base + 1, base + 2, base + 3, base + 4, base + 5];
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

// ─── Component ──────────────────────────────────────────────

export function PackagingCalendar({
  skus,
  families,
  getPlanned,
  assignToCalendar,
  setPlanQty,
  setPlanDay,
  setPlanTeam,
  fillFamilySuggestions,
  getExistingTeam,
  getExistingQty,
  getExistingDay,
  moveExisting,
  onOpenCardModal,
}: PackagingCalendarProps) {
  const NUM_WEEKS = 6;
  const [startWeek, setStartWeek] = useState(0);
  const [dragData, setDragData] = useState<{ productCode: string; source: AssemblySource; fromDayInt?: number; fromTeam?: PackingTeam } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ dayInt: number; team: PackingTeam } | null>(null);
  const openCardModal = useCallback(
    (a: { productCode: string; quantity?: number; dayInt?: number; team?: PackingTeam }) => {
      onOpenCardModal?.({
        productCode: a.productCode,
        runQuantity: a.quantity,
        runDayInt: a.dayInt,
        runTeam: a.team,
      });
    },
    [onOpenCardModal],
  );
  // Multi-select IDs for cards in the in-grid Unassigned row. Format:
  // `${source}:${productCode}` matches the React key used by CalendarCard so
  // lookups can round-trip. Selection is cleared whenever the relevant cards
  // are moved, or explicitly via the per-cell Clear button.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Families collapsed in the sidebar. A family is keyed by its `familyCode`
  // (same key the grouping uses). Collapsed state persists across renders
  // but not across page reloads — operators typically want a fresh view.
  const [collapsedFamilies, setCollapsedFamilies] = useState<Set<string>>(new Set());
  const toggleFamilyCollapsed = useCallback((familyCode: string) => {
    setCollapsedFamilies(prev => {
      const next = new Set(prev);
      if (next.has(familyCode)) next.delete(familyCode);
      else next.add(familyCode);
      return next;
    });
  }, []);

  // Per-SKU team memory: remembers which team a product was last placed on
  // so that dropping the same product onto an Unassigned cell auto-routes
  // to the same team without a second drag. Persisted across reloads.
  const TEAM_MEMORY_KEY = 'byron-packaging-team-memory-v1';
  const [teamMemory, setTeamMemory] = useState<Record<string, PackingTeam>>({});
  useEffect(() => {
    try {
      const raw = localStorage.getItem(TEAM_MEMORY_KEY);
      if (raw) setTeamMemory(JSON.parse(raw));
    } catch { /* ignore */ }
  }, []);
  const recordTeamMemory = useCallback((code: string, team: PackingTeam) => {
    setTeamMemory(prev => {
      if (prev[code] === team) return prev;
      const next = { ...prev, [code]: team };
      try { localStorage.setItem(TEAM_MEMORY_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Per-cell manual order: an explicit ordering of product codes for a given
  // (dayInt, team) cell. Overrides the default daysAvailable-asc sort. A code
  // appears in at most one cell at a time — inserting it into a new cell
  // drops it from any previous one. Persisted across reloads.
  const CELL_ORDER_KEY = 'byron-packaging-cell-order-v1';
  const [cellOrder, setCellOrder] = useState<Record<string, string[]>>({});
  useEffect(() => {
    try {
      const raw = localStorage.getItem(CELL_ORDER_KEY);
      if (raw) setCellOrder(JSON.parse(raw));
    } catch { /* ignore */ }
  }, []);
  const cellKeyOf = (dayInt: number, team?: PackingTeam) =>
    `${dayInt}:${team ?? '__unassigned'}`;
  const setCellOrderState = useCallback((next: Record<string, string[]>) => {
    setCellOrder(next);
    try { localStorage.setItem(CELL_ORDER_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }, []);
  /**
   * Insert `code` into the target cell's manual order, optionally before
   * `beforeCode`. Removes the code from any other cell first so the order
   * map stays unique per code.
   */
  const insertIntoCellOrder = useCallback(
    (dayInt: number, team: PackingTeam | undefined, code: string, beforeCode?: string) => {
      const key = cellKeyOf(dayInt, team);
      const next: Record<string, string[]> = {};
      for (const [k, arr] of Object.entries(cellOrder)) {
        const filtered = arr.filter(c => c !== code);
        if (filtered.length > 0) next[k] = filtered;
      }
      const target = next[key] ? [...next[key]] : [];
      if (beforeCode && beforeCode !== code) {
        const idx = target.indexOf(beforeCode);
        if (idx >= 0) target.splice(idx, 0, code);
        else target.push(code);
      } else {
        target.push(code);
      }
      next[key] = target;
      setCellOrderState(next);
    },
    [cellOrder, setCellOrderState]
  );
  /**
   * Remove a code from every cell's manual order — used when a card is
   * returned to the sidebar so a future re-drop starts fresh in priority
   * position rather than picking up a stale manual slot.
   */
  const removeFromCellOrder = useCallback(
    (code: string) => {
      let changed = false;
      const next: Record<string, string[]> = {};
      for (const [k, arr] of Object.entries(cellOrder)) {
        const filtered = arr.filter(c => c !== code);
        if (filtered.length !== arr.length) changed = true;
        if (filtered.length > 0) next[k] = filtered;
      }
      if (changed) setCellOrderState(next);
    },
    [cellOrder, setCellOrderState]
  );

  const assemblyId = (a: { source: AssemblySource; productCode: string }) =>
    `${a.source}:${a.productCode}`;

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Build array of weeks, each containing 5 dayInts
  const weeks = useMemo(() => {
    const result: { offset: number; days: number[]; label: string }[] = [];
    for (let w = 0; w < NUM_WEEKS; w++) {
      const wo = startWeek + w;
      const days = weekDayInts(wo);
      let label: string;
      if (wo === 0) label = 'This Week';
      else if (wo === 1) label = 'Next Week';
      else label = `Week +${wo}`;
      result.push({ offset: wo, days, label });
    }
    return result;
  }, [startWeek]);

  // Flat list of all visible dayInts (for pool filtering etc.)
  const allDays = useMemo(() => weeks.flatMap(w => w.days), [weeks]);

  // Build calendar assemblies from both planned drafts and existing Unleashed
  // assemblies. Existing entries render as live cards; any local edit to an
  // existing entry's team/day shows as a "pending update" without blocking
  // the original from appearing in its new location.
  const { scheduled, unscheduled } = useMemo(() => {
    const scheduled: CalendarAssembly[] = [];
    const unscheduled: CalendarAssembly[] = [];
    const plannedCreateCodes = new Set<string>();

    // 1. Draft CREATE entries (new assemblies the user is planning this session)
    for (const sku of skus) {
      const plan = getPlanned(sku.productCode);
      if (!plan || plan.quantity <= 0) continue;
      plannedCreateCodes.add(sku.productCode);

      const feas = computeFeasibility(sku, plan.quantity);
      const entry: CalendarAssembly = {
        productCode: sku.productCode,
        productName: sku.productName,
        familyCode: sku.familyCode,
        familyName: sku.familyName,
        sizeVariant: sku.sizeVariant,
        quantity: plan.quantity,
        dayInt: plan.dayInt,
        team: plan.team as PackingTeam | undefined,
        suggestedQty: sku.suggestedQty,
        kgPerUnit: sku.kgPerUnit,
        daysAvailable: sku.daysAvailable,
        source: 'planned',
        feasibility: feas.state,
        feasibilityReason: feas.reason,
      };

      if (plan.dayInt > 0) {
        scheduled.push(entry);
      } else {
        unscheduled.push(entry);
      }
    }

    // 2. Existing Unleashed assemblies — one per SKU with `existingAssemblyId`.
    //    If the user has dragged/edited this one, render at the EDITED
    //    (day, team, qty) so the calendar and the table's "Existing" columns
    //    stay in lockstep. A pendingUpdate badge appears whenever any field
    //    differs from the Unleashed source of truth.
    for (const sku of skus) {
      if (!sku.existingAssemblyId) continue;
      if (!sku.existingAssemblyQty || sku.existingAssemblyQty <= 0) continue;
      if (plannedCreateCodes.has(sku.productCode)) continue; // draft takes precedence for this SKU

      const origDayInt = sku.existingAssemblyDate
        ? dateToDayInt(new Date(sku.existingAssemblyDate), undefined, { weekend: 'up' })
        : 0;
      const origTeam = sku.existingAssemblyTeam;
      const origQty = sku.existingAssemblyQty;

      // null/undefined from these getters = "no edit yet"; fall back to original.
      const editedTeam = getExistingTeam(sku.productCode);
      const editedDay = getExistingDay(sku.productCode);
      const editedQty = getExistingQty(sku.productCode);

      const hasDayEdit = editedDay !== null;
      const hasQtyEdit = editedQty !== null;
      // Team edits: `moveExisting(code, day, undefined)` explicitly clears the
      // team. We can't distinguish "no edit yet" from "cleared" purely from
      // the team getter, so we treat day/qty presence as the edit signal and
      // use team as-is.
      const hasAnyEdit = hasDayEdit || hasQtyEdit;

      const dayInt = hasDayEdit ? (editedDay as number) : origDayInt;
      const quantity = hasQtyEdit ? (editedQty as number) : origQty;
      const team = hasAnyEdit ? editedTeam : origTeam;

      const dayChanged = hasDayEdit && editedDay !== origDayInt;
      const qtyChanged = hasQtyEdit && editedQty !== origQty;
      const teamChanged = hasAnyEdit && team !== origTeam;
      const pendingUpdate = dayChanged || qtyChanged || teamChanged;

      const feas = computeFeasibility(sku, quantity);

      const entry: CalendarAssembly = {
        productCode: sku.productCode,
        productName: sku.productName,
        familyCode: sku.familyCode,
        familyName: sku.familyName,
        sizeVariant: sku.sizeVariant,
        quantity,
        dayInt,
        team,
        suggestedQty: sku.suggestedQty,
        kgPerUnit: sku.kgPerUnit,
        daysAvailable: sku.daysAvailable,
        source: 'existing',
        assemblyNumber: sku.existingAssemblyNumber,
        pendingUpdate,
        feasibility: feas.state,
        feasibilityReason: feas.reason,
      };

      if (dayInt > 0) scheduled.push(entry);
      else unscheduled.push(entry);
    }

    // Sort unscheduled by family then size
    unscheduled.sort((a, b) => a.familyName.localeCompare(b.familyName) || a.sizeVariant.localeCompare(b.sizeVariant));

    return { scheduled, unscheduled };
  }, [skus, getPlanned, getExistingTeam, getExistingDay, getExistingQty]);

  // Group scheduled by dayInt+team (items without team use '__unassigned').
  // Default order within a cell is `daysAvailable` ascending (closest to
  // stockout first). `cellOrder` overrides the default with an explicit
  // manual order — any codes the operator has explicitly positioned appear
  // first, in the order they set; everything else keeps the priority sort.
  const cellMap = useMemo(() => {
    const map = new Map<string, CalendarAssembly[]>();
    for (const a of scheduled) {
      const key = `${a.dayInt}:${a.team || '__unassigned'}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(a);
    }
    const prioritySort = (a: CalendarAssembly, b: CalendarAssembly) => {
      // Use daysAvailable ascending; Infinity lands after finite values.
      const ad = Number.isFinite(a.daysAvailable) ? a.daysAvailable : Number.MAX_VALUE;
      const bd = Number.isFinite(b.daysAvailable) ? b.daysAvailable : Number.MAX_VALUE;
      if (ad !== bd) return ad - bd;
      return a.familyName.localeCompare(b.familyName) || a.sizeVariant.localeCompare(b.sizeVariant);
    };
    for (const [key, arr] of map) {
      const manual = cellOrder[key];
      if (manual && manual.length > 0) {
        const manualSet = new Set(manual);
        const ordered = manual
          .map(code => arr.find(x => x.productCode === code))
          .filter((x): x is CalendarAssembly => !!x);
        const rest = arr
          .filter(x => !manualSet.has(x.productCode))
          .sort(prioritySort);
        map.set(key, [...ordered, ...rest]);
      } else {
        arr.sort(prioritySort);
      }
    }
    return map;
  }, [scheduled, cellOrder]);

  // Group unscheduled by family for the pool
  const poolFamilies = useMemo(() => {
    const map = new Map<string, CalendarAssembly[]>();
    for (const a of unscheduled) {
      if (!map.has(a.familyCode)) map.set(a.familyCode, []);
      map.get(a.familyCode)!.push(a);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [unscheduled]);

  // ── Drag handlers ──

  const handleDragStart = useCallback((e: React.DragEvent, productCode: string, source: AssemblySource, fromDayInt?: number, fromTeam?: PackingTeam) => {
    e.dataTransfer.effectAllowed = 'move';
    // Encode the source in the drag payload so a drop can route to either the
    // planned-CREATE path (`assignToCalendar`) or the existing-UPDATE path
    // (`moveExisting`) even when the dataTransfer object is all we have.
    e.dataTransfer.setData('text/plain', productCode);
    e.dataTransfer.setData('application/x-byron-source', source);
    setDragData({ productCode, source, fromDayInt, fromTeam });
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, dayInt: number, team: PackingTeam) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget({ dayInt, team });
  }, []);

  const handleDragLeave = useCallback(() => {
    setDropTarget(null);
  }, []);

  /**
   * Universal drop handler for a (dayInt, team|undefined) target. When the
   * team is undefined (Unassigned row drop), we consult `teamMemory` and
   * silently route to the remembered team if one exists. Drop position is
   * carried via `beforeCode` — when set, the card is inserted immediately
   * before that product code in the target cell's manual order.
   */
  const handleDrop = useCallback(
    (
      e: React.DragEvent,
      dayInt: number,
      team: PackingTeam | undefined,
      beforeCode?: string,
    ) => {
      e.preventDefault();
      e.stopPropagation();
      const productCode = e.dataTransfer.getData('text/plain');
      const source = (e.dataTransfer.getData('application/x-byron-source') || 'planned') as AssemblySource;
      if (!productCode) { setDragData(null); setDropTarget(null); return; }

      // If no explicit team (Unassigned row drop), consult team memory so
      // the operator doesn't have to re-steer the same SKU twice.
      const effectiveTeam = team ?? teamMemory[productCode];

      if (source === 'existing') {
        moveExisting(productCode, dayInt, effectiveTeam);
      } else if (effectiveTeam) {
        assignToCalendar(productCode, dayInt, effectiveTeam);
      } else {
        // Planned draft with no team at all (no memory, dropped in Unassigned).
        // Split setters so the draft lands on the day but stays teamless.
        setPlanDay(productCode, dayInt);
        setPlanTeam(productCode, undefined);
      }

      if (effectiveTeam) recordTeamMemory(productCode, effectiveTeam);
      insertIntoCellOrder(dayInt, effectiveTeam, productCode, beforeCode);

      setDragData(null);
      setDropTarget(null);
    },
    [assignToCalendar, moveExisting, setPlanDay, setPlanTeam, teamMemory, recordTeamMemory, insertIntoCellOrder]
  );

  const handleDragEnd = useCallback(() => {
    setDragData(null);
    setDropTarget(null);
  }, []);

  // ── Unassign (drag back to pool) ──
  const handlePoolDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handlePoolDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const productCode = e.dataTransfer.getData('text/plain');
    const source = (e.dataTransfer.getData('application/x-byron-source') || 'planned') as AssemblySource;
    if (productCode) {
      if (source === 'existing') {
        // For existing assemblies, "back to pool" clears the team edit.
        // Day is preserved (UPDATE can't un-schedule an existing Unleashed
        // assembly — it's already booked).
        moveExisting(productCode, 0, undefined);
      } else {
        setPlanTeam(productCode, undefined);
        setPlanDay(productCode, 0);
      }
      removeFromCellOrder(productCode);
    }
    setDragData(null);
    setDropTarget(null);
  }, [setPlanTeam, setPlanDay, moveExisting, removeFromCellOrder]);

  // ── Day labels per week ──
  const weekDayLabels = useMemo(() => {
    return weeks.map(w => w.days.map((di, idx) => {
      const date = dayIntToDate(di);
      const d = date.getDate();
      const m = date.toLocaleDateString('en-AU', { month: 'short' });
      return { dayInt: di, label: `${DAY_NAMES[idx]} ${d}`, monthLabel: m };
    }));
  }, [weeks]);

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* ── Unscheduled pool (left sidebar) ── */}
      <div
        className="flex-shrink-0 overflow-y-auto px-3 py-3"
        style={{ width: 220, borderRight: '0.5px solid var(--border)', background: 'var(--bg-surface)' }}
        onDragOver={handlePoolDragOver}
        onDrop={handlePoolDrop}
      >
        <div className="text-xs font-medium uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>
          Unassigned ({unscheduled.length})
        </div>
        {poolFamilies.length === 0 && (
          <div className="text-xs py-4 text-center" style={{ color: 'var(--text-muted)' }}>
            Plan quantities in the table view, then drag them here.
          </div>
        )}
        {poolFamilies.length > 0 && (
          <div className="flex items-center justify-between gap-2 mb-2">
            <button
              onClick={() => setCollapsedFamilies(new Set(poolFamilies.map(([fc]) => fc)))}
              className="text-[10px] transition hover:opacity-70"
              style={{ color: 'var(--text-muted)', textDecoration: 'underline' }}
            >
              collapse all
            </button>
            <button
              onClick={() => setCollapsedFamilies(new Set())}
              className="text-[10px] transition hover:opacity-70"
              style={{ color: 'var(--text-muted)', textDecoration: 'underline' }}
            >
              expand all
            </button>
          </div>
        )}
        {poolFamilies.map(([familyCode, items]) => {
          const isCollapsed = collapsedFamilies.has(familyCode);
          return (
            <div key={familyCode} className="mb-3">
              <button
                onClick={() => toggleFamilyCollapsed(familyCode)}
                className="w-full text-left text-[10px] font-medium uppercase tracking-wide mb-1 px-1 flex items-center gap-1 transition hover:opacity-80"
                style={{ color: 'var(--text-secondary)' }}
                title={isCollapsed ? 'Expand group' : 'Collapse group'}
              >
                <span
                  aria-hidden
                  style={{
                    display: 'inline-block',
                    width: 8,
                    transition: 'transform 120ms ease',
                    transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                  }}
                >
                  ▾
                </span>
                <span>{items[0].familyName}</span>
                <span className="ml-auto" style={{ color: 'var(--text-muted)' }}>
                  {items.length}
                </span>
              </button>
              {!isCollapsed && items.map(a => (
                <PoolCard
                  key={a.productCode}
                  assembly={a}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                />
              ))}
            </div>
          );
        })}
      </div>

      {/* ── Calendar grid ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Navigation */}
        <div className="flex items-center justify-between px-4 py-1.5" style={{ borderBottom: '0.5px solid var(--border)' }}>
          <button
            onClick={() => setStartWeek(w => Math.max(0, w - 1))}
            disabled={startWeek === 0}
            className="px-2 py-0.5 rounded text-xs transition hover:opacity-70 disabled:opacity-30"
            style={{ color: 'var(--text-secondary)', border: '0.5px solid var(--border)' }}
          >
            &larr; Earlier
          </button>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {weeks[0].label} &ndash; {weeks[weeks.length - 1].label}
          </span>
          <button
            onClick={() => setStartWeek(w => w + 1)}
            className="px-2 py-0.5 rounded text-xs transition hover:opacity-70"
            style={{ color: 'var(--text-secondary)', border: '0.5px solid var(--border)' }}
          >
            Later &rarr;
          </button>
        </div>

        {/* Grid — all weeks stacked */}
        <div className="flex-1 overflow-auto">
          <table className="w-full border-collapse table-fixed">
            <colgroup>
              <col style={{ width: 80 }} />
              {[0, 1, 2, 3, 4].map(i => <col key={i} />)}
            </colgroup>
            {weeks.map((week, wi) => (
              <tbody key={week.offset}>
                {/* Week header row */}
                <tr>
                  <th
                    colSpan={6}
                    className="text-left px-2 py-1.5 text-xs font-medium uppercase tracking-wide"
                    style={{
                      color: 'var(--text-secondary)',
                      background: 'var(--bg-surface)',
                      borderBottom: '0.5px solid var(--border)',
                      borderTop: wi > 0 ? '2px solid var(--border)' : undefined,
                      position: 'sticky',
                      top: 0,
                      zIndex: 3,
                    }}
                  >
                    {week.label}
                    <span className="ml-2 font-normal" style={{ color: 'var(--text-muted)' }}>
                      {weekDayLabels[wi][0].label} {weekDayLabels[wi][0].monthLabel} &ndash; {weekDayLabels[wi][4].label} {weekDayLabels[wi][4].monthLabel}
                    </span>
                  </th>
                </tr>
                {/* Day headers */}
                <tr>
                  <th className="text-left px-2 py-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)', borderBottom: '0.5px solid var(--border)' }}>
                    Team
                  </th>
                  {weekDayLabels[wi].map(({ dayInt, label }) => (
                    <th key={dayInt} className="text-center px-1 py-1 text-[10px]" style={{ color: 'var(--text-muted)', borderBottom: '0.5px solid var(--border)', borderLeft: '0.5px solid var(--border)' }}>
                      {label}
                    </th>
                  ))}
                </tr>
                {/* Team rows */}
                {PACKING_TEAMS.map(team => (
                  <tr key={`${week.offset}:${team}`}>
                    <td
                      className="px-2 py-1 text-[11px] font-medium align-top"
                      style={{
                        color: TEAM_COLORS[team],
                        borderBottom: '0.5px solid var(--border)',
                        verticalAlign: 'top',
                      }}
                    >
                      <div className="flex items-center gap-1">
                        <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: TEAM_COLORS[team] }} />
                        {TEAM_LABELS[team]}
                      </div>
                    </td>
                    {week.days.map(dayInt => {
                      const key = `${dayInt}:${team}`;
                      const items = cellMap.get(key) || [];
                      const isOver = dropTarget?.dayInt === dayInt && dropTarget?.team === team;
                      return (
                        <td
                          key={dayInt}
                          className="align-top px-1 py-0.5"
                          style={{
                            borderBottom: '0.5px solid var(--border)',
                            borderLeft: '0.5px solid var(--border)',
                            background: isOver ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : undefined,
                            transition: 'background 0.15s',
                          }}
                          onDragOver={e => handleDragOver(e, dayInt, team)}
                          onDragLeave={handleDragLeave}
                          onDrop={e => handleDrop(e, dayInt, team)}
                        >
                          <div className="min-h-[36px] flex flex-col gap-0.5">
                            {items.map(a => (
                              <div
                                key={`${a.source}:${a.productCode}`}
                                onDragOver={(e) => {
                                  // Allow dropping at this card's position without
                                  // the cell-level handler also firing (which would
                                  // treat it as an "append"). Stop propagation so
                                  // only this drop target wins.
                                  e.preventDefault();
                                  e.stopPropagation();
                                  e.dataTransfer.dropEffect = 'move';
                                  setDropTarget({ dayInt, team });
                                }}
                                onDrop={(e) => handleDrop(e, dayInt, team, a.productCode)}
                              >
                                <CalendarCard
                                  assembly={a}
                                  teamColor={TEAM_COLORS[team]}
                                  onDragStart={handleDragStart}
                                  onDragEnd={handleDragEnd}
                                  onClick={() => openCardModal(a)}
                                  onRemove={() => {
                                    if (a.source === 'existing') {
                                      moveExisting(a.productCode, 0, undefined);
                                    } else {
                                      setPlanTeam(a.productCode, undefined);
                                      setPlanDay(a.productCode, 0);
                                    }
                                    removeFromCellOrder(a.productCode);
                                  }}
                                />
                              </div>
                            ))}
                            {items.length > 0 && (() => {
                              const totalUnits = items.reduce((s, a) => s + a.quantity, 0);
                              return (
                                <div className="mt-0.5 pt-0.5 text-[9px] font-mono text-right" style={{ borderTop: '0.5px solid var(--border)', color: 'var(--text-muted)' }}>
                                  {totalUnits.toLocaleString()}
                                </div>
                              );
                            })()}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {/* Unassigned row — items with a day but no team */}
                {(() => {
                  const hasUnassigned = week.days.some(di => (cellMap.get(`${di}:__unassigned`) || []).length > 0);
                  if (!hasUnassigned) return null;
                  return (
                    <tr key={`${week.offset}:__unassigned`}>
                      <td
                        className="px-2 py-1 text-[11px] font-medium align-top italic"
                        style={{
                          color: 'var(--text-muted)',
                          borderBottom: '0.5px solid var(--border)',
                          verticalAlign: 'top',
                        }}
                      >
                        Unassigned
                      </td>
                      {week.days.map(dayInt => {
                        const items = cellMap.get(`${dayInt}:__unassigned`) || [];
                        const selectedInCell = items.filter(a => selectedIds.has(assemblyId(a)));
                        const hasSelection = selectedInCell.length > 0;
                        const moveToSidebar = (batch: typeof items) => {
                          for (const a of batch) {
                            if (a.source === 'existing') {
                              moveExisting(a.productCode, 0, undefined);
                            } else {
                              setPlanTeam(a.productCode, undefined);
                              setPlanDay(a.productCode, 0);
                            }
                            removeFromCellOrder(a.productCode);
                          }
                          // Clear any selection IDs that were just moved; leave
                          // unrelated selections intact so a user cleaning up
                          // several days in sequence keeps their state.
                          if (batch.length > 0) {
                            setSelectedIds(prev => {
                              const next = new Set(prev);
                              for (const a of batch) next.delete(assemblyId(a));
                              return next;
                            });
                          }
                        };
                        return (
                          <td
                            key={dayInt}
                            className="align-top px-1 py-0.5"
                            style={{
                              borderBottom: '0.5px solid var(--border)',
                              borderLeft: '0.5px solid var(--border)',
                              background: items.length > 0 ? 'color-mix(in srgb, var(--text-muted) 4%, transparent)' : undefined,
                            }}
                            onDragOver={(e) => {
                              e.preventDefault();
                              e.dataTransfer.dropEffect = 'move';
                            }}
                            onDrop={(e) => handleDrop(e, dayInt, undefined)}
                          >
                            <div className="min-h-[36px] flex flex-col gap-0.5">
                              {items.length > 0 && (
                                <div className="flex items-center justify-between gap-1 mb-0.5">
                                  <button
                                    onClick={() => moveToSidebar(hasSelection ? selectedInCell : items)}
                                    title={hasSelection
                                      ? `Move ${selectedInCell.length} selected card${selectedInCell.length === 1 ? '' : 's'} back to the sidebar`
                                      : `Move all ${items.length} card${items.length === 1 ? '' : 's'} on this day back to the sidebar`}
                                    className="text-[9px] px-1.5 py-0.5 rounded transition hover:opacity-85"
                                    style={{
                                      fontWeight: 600,
                                      color: 'var(--accent)',
                                      background: 'var(--bg-page)',
                                      border: '0.5px solid var(--accent)',
                                    }}
                                  >
                                    {hasSelection
                                      ? `→ sidebar (${selectedInCell.length})`
                                      : `→ sidebar (all ${items.length})`}
                                  </button>
                                  {hasSelection && (
                                    <button
                                      onClick={() => {
                                        setSelectedIds(prev => {
                                          const next = new Set(prev);
                                          for (const a of selectedInCell) next.delete(assemblyId(a));
                                          return next;
                                        });
                                      }}
                                      title="Clear selection on this day"
                                      className="text-[9px] px-1 py-0.5 rounded transition hover:opacity-70"
                                      style={{ color: 'var(--text-muted)' }}
                                    >
                                      clear
                                    </button>
                                  )}
                                </div>
                              )}
                              {items.map(a => {
                                const id = assemblyId(a);
                                const isSelected = selectedIds.has(id);
                                return (
                                  <div
                                    key={id}
                                    onClick={(e) => {
                                      // Shift/Ctrl/Cmd toggles this card's selection
                                      // without interfering with drag (drag requires
                                      // mousedown + move; plain click fires here).
                                      if (e.shiftKey || e.ctrlKey || e.metaKey) {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        toggleSelected(id);
                                      }
                                    }}
                                    onDragOver={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      e.dataTransfer.dropEffect = 'move';
                                    }}
                                    onDrop={(e) => handleDrop(e, dayInt, undefined, a.productCode)}
                                    style={{
                                      outline: isSelected ? '2px solid var(--accent)' : undefined,
                                      outlineOffset: isSelected ? '1px' : undefined,
                                      borderRadius: 4,
                                    }}
                                  >
                                    <CalendarCard
                                      assembly={a}
                                      teamColor="var(--text-muted)"
                                      onDragStart={handleDragStart}
                                      onDragEnd={handleDragEnd}
                                      onClick={() => openCardModal(a)}
                                      onRemove={() => moveToSidebar([a])}
                                    />
                                  </div>
                                );
                              })}
                              {items.length > 0 && (() => {
                                const totalUnits = items.reduce((s, a) => s + a.quantity, 0);
                                return (
                                  <div className="mt-0.5 pt-0.5 text-[9px] font-mono text-right" style={{ borderTop: '0.5px solid var(--border)', color: 'var(--text-muted)' }}>
                                    {totalUnits.toLocaleString()}
                                  </div>
                                );
                              })()}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })()}
              </tbody>
            ))}
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Pool Card (sidebar) ────────────────────────────────────

function PoolCard({
  assembly,
  onDragStart,
  onDragEnd,
}: {
  assembly: CalendarAssembly;
  onDragStart: (e: React.DragEvent, code: string, source: AssemblySource) => void;
  onDragEnd: () => void;
}) {
  // Truncate product name
  const shortName = assembly.productName.length > 28
    ? assembly.productName.slice(0, 26) + '...'
    : assembly.productName;

  const isLive = assembly.source === 'existing';

  return (
    <div
      draggable
      onDragStart={e => onDragStart(e, assembly.productCode, assembly.source)}
      onDragEnd={onDragEnd}
      className="rounded px-2 py-1 mb-1 cursor-grab active:cursor-grabbing transition hover:opacity-80"
      style={{
        background: FEASIBILITY_BG[assembly.feasibility],
        border: isLive
          ? `0.5px dashed ${FEASIBILITY_BORDER[assembly.feasibility]}`
          : `0.5px solid ${FEASIBILITY_BORDER[assembly.feasibility]}`,
        fontSize: 11,
      }}
      title={assembly.feasibilityReason}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="truncate" style={{ color: 'var(--text-primary)' }} title={assembly.productName}>
          {shortName}
        </span>
        <span className="flex-shrink-0 font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {assembly.sizeVariant}
        </span>
      </div>
      <div className="flex items-center justify-between mt-0.5 gap-1">
        <span className="font-mono text-[9px] truncate" style={{ color: 'var(--text-muted)' }} title={assembly.productCode}>
          {assembly.productCode}
        </span>
        <span className="font-mono font-medium text-[10px] flex-shrink-0" style={{ color: 'var(--text-primary)' }}>
          {assembly.quantity.toLocaleString()}
        </span>
      </div>
      {isLive && assembly.assemblyNumber && (
        <div className="text-[9px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
          #{assembly.assemblyNumber}
        </div>
      )}
    </div>
  );
}

// ─── Calendar Card (in grid cell) ───────────────────────────

/**
 * Derive a short, meaningful card label from the product name.
 *
 * Strategy (in priority order):
 *   1. Strip any parenthetical tail `(250g)` and the " - " separator that
 *      Unleashed puts between the base name and descriptors. What's left is
 *      usually the readable short name (e.g. "Brazil Nuts", "Mindful Foods").
 *   2. If we have a `sizeVariant`, append it.
 *   3. Cap at ~24 chars on a word boundary (ellipsis rather than mid-word cut).
 *
 * Avoids the previous approaches' failure modes:
 *   - Stitching `familyName.split(' ')[0] + size` produced "IAC LRG" when the
 *     intermediate code wasn't in `INTERMEDIATE_NAMES`.
 *   - `productName.slice(0, 20)` produced "Mindful Foods Chocol" (mid-word).
 */
function cardLabel(assembly: CalendarAssembly): string {
  const raw = assembly.productName || assembly.productCode || '';
  // Strip trailing parenthetical: "Brazil Nuts - ORG MED (325g)" → "Brazil Nuts - ORG MED"
  const noParens = raw.replace(/\s*\([^)]*\)\s*$/, '');
  // Take the part before the first " - " separator: "Brazil Nuts - ORG MED" → "Brazil Nuts"
  const shortName = noParens.split(/\s+-\s+/)[0].trim() || raw;

  const combined = assembly.sizeVariant
    ? `${shortName} ${assembly.sizeVariant}`
    : shortName;

  if (combined.length <= 24) return combined;

  // Word-boundary truncate.
  const cut = combined.slice(0, 24);
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = lastSpace > 10 ? cut.slice(0, lastSpace) : cut;
  return `${trimmed}…`;
}

function CalendarCard({
  assembly,
  teamColor,
  onDragStart,
  onDragEnd,
  onRemove,
  onClick,
}: {
  assembly: CalendarAssembly;
  teamColor: string;
  onDragStart: (e: React.DragEvent, code: string, source: AssemblySource, dayInt?: number, team?: PackingTeam) => void;
  onDragEnd: () => void;
  onRemove: () => void;
  /**
   * Plain-click handler. Fires on mouseup without mouse movement so it
   * doesn't interfere with drag (which requires mousedown+move). Use it to
   * open the BOM investigation modal or any other info UI.
   */
  onClick?: (e: React.MouseEvent) => void;
}) {
  const label = cardLabel(assembly);

  const kg = assembly.kgPerUnit > 0
    ? (assembly.quantity * assembly.kgPerUnit).toFixed(1)
    : null;

  const isLive = assembly.source === 'existing';
  const titleBits = [
    assembly.productName,
    `${assembly.productCode} — ${assembly.quantity.toLocaleString()} units${kg ? ` (${kg}kg)` : ''}`,
  ];
  if (assembly.feasibility === 'amber' || assembly.feasibility === 'red') {
    titleBits.push(assembly.feasibilityReason || (
      assembly.feasibility === 'red'
        ? 'Insufficient components globally'
        : 'Requires warehouse transfer'
    ));
  }
  if (isLive) {
    titleBits.push(`Live Unleashed assembly${assembly.assemblyNumber ? ` #${assembly.assemblyNumber}` : ''}`);
  }
  if (assembly.pendingUpdate) {
    titleBits.push('Pending update — will push on next sync');
  }

  return (
    <div
      draggable
      onDragStart={e => onDragStart(e, assembly.productCode, assembly.source, assembly.dayInt, assembly.team)}
      onDragEnd={onDragEnd}
      onClick={(e) => {
        // Shift/Ctrl/Cmd-click is reserved for multi-select in the Unassigned
        // row (handled by the wrapper). Let those pass through.
        if (e.shiftKey || e.ctrlKey || e.metaKey) return;
        onClick?.(e);
      }}
      className="rounded px-1.5 py-0.5 cursor-grab active:cursor-grabbing group transition hover:opacity-80 relative"
      style={{
        background: FEASIBILITY_BG[assembly.feasibility],
        borderLeft: `2.5px solid ${teamColor}`,
        // Outline signals source + pending-edit; colour signals feasibility.
        outline: isLive
          ? assembly.pendingUpdate
            ? '1px dotted var(--warning)'
            : `0.5px dashed ${FEASIBILITY_BORDER[assembly.feasibility]}`
          : `0.5px solid ${FEASIBILITY_BORDER[assembly.feasibility]}`,
        outlineOffset: isLive ? -1 : undefined,
        fontSize: 11,
      }}
      title={titleBits.join('\n')}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="truncate" style={{ color: 'var(--text-primary)' }}>
          {label}
        </span>
        <span className="font-mono text-[10px] font-medium flex-shrink-0" style={{ color: 'var(--accent)' }}>
          {assembly.quantity.toLocaleString()}
        </span>
      </div>
      <div className="flex items-center justify-between gap-1">
        <span
          className="font-mono text-[9px] truncate"
          style={{ color: 'var(--text-muted)' }}
          title={assembly.productCode}
        >
          {assembly.productCode}
        </span>
        <div className="flex items-center gap-1 flex-shrink-0">
          {kg && (
            <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{kg}kg</span>
          )}
          {isLive && (
            <span
              className="text-[8px] px-1 rounded uppercase tracking-wider"
              style={{
                color: assembly.pendingUpdate ? 'var(--warning)' : 'var(--accent)',
                background: 'var(--bg-page)',
                fontWeight: 600,
                lineHeight: 1.3,
              }}
              title={assembly.assemblyNumber ? `Unleashed #${assembly.assemblyNumber}` : 'Live Unleashed assembly'}
            >
              {assembly.pendingUpdate ? 'edit' : 'live'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
