'use client';

/**
 * CalendarApp — Phase 4a/b/c/d client component.
 *
 * Reads pre-computed projection data from the server component and renders:
 *   - A 12-week month-by-month calendar grid with activity chips per day
 *   - Per-station layer toggles (left rail) with peak-load badges
 *   - Coverage / changeover summary KPIs (left rail)
 *   - Activity drawer (right rail) with Dismiss/Undismiss
 *   - Persistent dismissals overlaid on the engine output
 *
 * Mutation model: the server runs the engine, the client applies a
 * localStorage-backed mutations layer on top (`calendar-mutations.ts`).
 * Dismissed activities render with reduced opacity and don't count
 * toward day-load. A "Show dismissed" toggle in the left rail hides
 * them entirely.
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';
import { useRouter } from 'next/navigation';
import type {
  CalendarActivity,
  DayLoadSummary,
} from '@/lib/planning/calendar-projection';
import {
  applyDismiss,
  applyUndismiss,
  isDismissed,
  applyReschedule,
  applyClearReschedule,
  rescheduledTo,
  applyEditQuantity,
  applyClearEdit,
  editedQuantityOf,
  applyEditLeadTime,
  applyClearLeadTime,
  editedLeadTimeDaysOf,
  leadTimeOverridesByCode,
  clearStale,
  staleStableIds,
  readMutationsFromStorage,
  writeMutationsToStorage,
  applyMutationsToActivities,
  type MutationsMap,
} from '@/lib/planning/calendar-mutations';
import { projectPoChips } from '@/lib/planning/po-projection';
import {
  buildPoCsv,
  buildPackagingCsv,
  buildKitchenCsv,
} from '@/lib/planning/report-csv';
import {
  buildPoHtml,
  buildPackagingHtml,
  buildKitchenHtml,
} from '@/lib/planning/report-html';
import {
  detectScheduleConflicts,
  type ScheduleConflict,
} from '@/lib/engine/schedule-conflicts';
import type {
  RawMaterialShortage,
  PurchaseRequirement,
} from '@/lib/engine/raw-material-demand';
import {
  resolveScheduleConflicts,
  type ResolveStrategy,
} from '@/lib/engine/resolve-conflicts';
import type { PlanningHorizon, Station } from '@/lib/planning/engine-io';

// ─── Types ───────────────────────────────────────────────────

interface SummaryProps {
  productCount: number;
  feasibleCount: number;
  infeasibleCount: number;
  totalChangeoverMinutes: number;
  orchestratorWarningCount: number;
  dayAssignerWarningCount: number;
  capacityWarningCount: number;
  demandSourceMtime: string | null;
}

interface InfeasibleProduct {
  productCode: string;
  productName: string;
  station: string;
  unmetUnits: number;
  reason: string;
}

interface ProductOverrideShape {
  shelfLifeDays?: number;
  maxBatchSize?: number;
}

interface CalendarAppProps {
  horizon: PlanningHorizon;
  activities: CalendarActivity[];
  dayLoads: DayLoadSummary[];
  assembliesFetchedAt: string | null;
  kitchenActivityCount: number;
  kitchenRequiredCount: number;
  /** Per-station daily capacity in minutes. Used for client-side load recompute. */
  stationDailyMinutes: Record<string, number>;
  /**
   * Per-recipe kitchen-team minutes (Phase 4l.8). Used by the kitchen
   * heatmap and by the resolver for capacity walks. Activities whose
   * productCode isn't in the map fall back to KITCHEN_DEFAULT_MINUTES.
   */
  kitchenMinutesByProductCode: Record<string, number>;
  infeasibleProducts: InfeasibleProduct[];
  /** productCode → cost-router rationale string (why this station was chosen). */
  routingDecisions: Record<string, string>;
  /** Per-product override map currently on disk (server reads on each render). */
  productOverrides: Record<string, ProductOverrideShape>;
  /** Per-product station daily output (units), used as default for max-batch override. */
  productStationDailyOutput: Record<string, number>;
  /** SOH per (product code, warehouse name); empty when no cache file exists. */
  sohByProductCode: Record<string, Record<string, number>>;
  /** ISO timestamp of the last SOH refresh, or null when cache is missing. */
  sohFetchedAt: string | null;
  /** Warehouses present in the SOH cache (informational, for the drawer breakdown). */
  availableWarehouses: string[];
  /** Warehouses whose stock the planner counts as fulfilment-eligible. */
  eligibleWarehouses: string[];
  /** Per-product effective initialInventory (= sum of SOH across eligibleWarehouses). */
  initialInventoryByProduct: Record<string, number>;
  /** Per-product list of active sales-order lines. Empty when no commitments. */
  salesOrdersByProduct: Record<
    string,
    Array<{
      orderNumber: string;
      customerName: string;
      orderStatus: string;
      requiredDate: string;
      quantityRemaining: number;
    }>
  >;
  /** Per-product total committed units across all active orders. */
  committedByProduct: Record<string, number>;
  salesOrdersFetchedAt: string | null;
  totalSalesOrderLines: number;
  /** Raw-material projection — first-shortage rows for the risks panel. */
  rawMaterialShortages: RawMaterialShortage[];
  /** Derived PO place-by requirements (Phase 4m.1). */
  purchaseRequirements: PurchaseRequirement[];
  /** Per-raw-material vendor name from data/raw-material-lead-times.json. */
  vendorByCode: Record<string, string>;
  /** Today's date as YYYY-MM-DD local — used by the client-side PO projector. */
  todayLocal: string;
  /** Global defaults the user can override per product. */
  globalDefaults: { shelfLifeDays: number };
  /** Horizon-week options surfaced in the picker (e.g. 12 / 16 / 20 / 26). */
  horizonOptions: number[];
  /** productCode → list of intermediate codes its BOM consumes (depth 1). For conflict detection. */
  consumesMap: Record<string, string[]>;
  summary: SummaryProps;
}

// ─── Constants ───────────────────────────────────────────────

const STATIONS: Station[] = ['hand-packing', 'elephant', 'dust', 'bottlo'];

/**
 * Kitchen-team capacity model (Phase 4l.7 / 4l.8).
 * Used both by the resolver (push/pull past kitchen-overloaded days) and by
 * the calendar heatmap so the user sees the same load picture the resolver
 * does.
 *
 * 8-hour kitchen day → 480 minutes total.
 *
 * Per-recipe minutes come from the spreadsheet via `kitchenTeamMinutesFor`,
 * passed in as `kitchenMinutesByProductCode`. Activities whose productCode
 * isn't in that map (unusual but possible — e.g. a kitchen-required chip
 * for an intermediate that isn't in the kitchen-processes sheet) fall back
 * to `KITCHEN_DEFAULT_CHIP_MINUTES`.
 */
const KITCHEN_DAILY_MINUTES = 480;
const KITCHEN_DEFAULT_CHIP_MINUTES = 240;

interface ChipColor { bg: string; border: string; text: string; dot: string }

const STATION_COLORS: Record<Station, ChipColor> = {
  'hand-packing': { bg: '#fef3c7', border: '#f59e0b', text: '#78350f', dot: '#f59e0b' },
  elephant: { bg: '#dbeafe', border: '#3b82f6', text: '#1e3a8a', dot: '#3b82f6' },
  dust: { bg: '#ede9fe', border: '#8b5cf6', text: '#4c1d95', dot: '#8b5cf6' },
  bottlo: { bg: '#d1fae5', border: '#10b981', text: '#065f46', dot: '#10b981' },
};

const STATION_LABELS: Record<Station, string> = {
  'hand-packing': 'Hand packing',
  elephant: 'Elephant',
  dust: 'Dust',
  bottlo: 'Bottlo',
};

/** Distinct colour for kitchen activities — pink/rose, separate from packaging stations. */
const KITCHEN_COLOR: ChipColor = {
  bg: '#fce7f3',
  border: '#ec4899',
  text: '#831843',
  dot: '#ec4899',
};

/**
 * Kitchen-REQUIRED runs (derived shortfalls): orange. Distinct from
 * kitchen-scheduled (pink) so the operator can immediately see "this needs
 * to be added" vs "this is already on the books."
 */
const KITCHEN_REQUIRED_COLOR: ChipColor = {
  bg: '#ffedd5',
  border: '#f97316',
  text: '#9a3412',
  dot: '#f97316',
};

/** PO place-by chip — yellow/amber to read as "action needed". */
const PO_PLACED_COLOR: ChipColor = {
  bg: '#fef3c7',
  border: '#d97706',
  text: '#78350f',
  dot: '#d97706',
};
/** PO arrive-by chip — soft green to read as "delivery, positive". */
const PO_RECEIVING_COLOR: ChipColor = {
  bg: '#d1fae5',
  border: '#059669',
  text: '#064e3b',
  dot: '#059669',
};
/** Override colour when a PO is overdue (placeBy < today). */
const PO_OVERDUE_COLOR: ChipColor = {
  bg: '#fee2e2',
  border: '#dc2626',
  text: '#7f1d1d',
  dot: '#dc2626',
};

/** Pick the chip's colour scheme based on kind + station. */
function colorOf(activity: CalendarActivity): ChipColor {
  if (activity.kind === 'kitchen') return KITCHEN_COLOR;
  if (activity.kind === 'kitchen-required') return KITCHEN_REQUIRED_COLOR;
  if (activity.kind === 'po-placed') {
    return activity.poInfo?.overdue ? PO_OVERDUE_COLOR : PO_PLACED_COLOR;
  }
  if (activity.kind === 'po-receiving') {
    return activity.poInfo?.overdue ? PO_OVERDUE_COLOR : PO_RECEIVING_COLOR;
  }
  return activity.station ? STATION_COLORS[activity.station] : KITCHEN_COLOR;
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ─── Helpers ─────────────────────────────────────────────────

/** ISO YYYY-MM-DD → Date in local time (avoids UTC drift). */
function fromISO(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Date → ISO YYYY-MM-DD in local time. */
function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Add `days` to an ISO date in local time. Used by the drawer for PO arrive-by computation. */
function addDaysIso(iso: string, days: number): string {
  const d = fromISO(iso);
  d.setDate(d.getDate() + days);
  return toISO(d);
}

/** Group activities by date for fast per-day lookup. */
function groupByDate(activities: CalendarActivity[]): Map<string, CalendarActivity[]> {
  const out = new Map<string, CalendarActivity[]>();
  for (const a of activities) {
    let arr = out.get(a.date);
    if (!arr) {
      arr = [];
      out.set(a.date, arr);
    }
    arr.push(a);
  }
  return out;
}

/** Build a flat list of dates spanning N weeks from a Monday startDate. */
function horizonDates(startWeek: string, weeks: number): string[] {
  const start = fromISO(startWeek);
  const out: string[] = [];
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    out.push(toISO(d));
  }
  return out;
}

function fmtDayShort(iso: string): string {
  const d = fromISO(iso);
  return `${d.getDate()}`;
}

function fmtMonthYear(iso: string): string {
  const d = fromISO(iso);
  return d.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
}

/**
 * Display format for any user-visible date: dd/mm/yyyy.
 * Internal storage stays in ISO YYYY-MM-DD; this is the single conversion
 * point so every date label in the UI matches.
 */
function fmtDate(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** Format an ISO timestamp (e.g. fs mtime) as dd/mm/yyyy in local time. */
function fmtDateFromTimestamp(iso: string): string {
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return '';
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${d}/${m}/${y}`;
}

/** Trigger a browser download of `csv` as a file with `filename`. */
function downloadCsv(csv: string, filename: string): void {
  if (typeof window === 'undefined') return;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Allow the click handler to flush before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Open a printable report in a new window. The HTML carries its own
 * `window.print()` call, so the print dialog opens automatically once the
 * window finishes loading. Falls back to alerting when popups are blocked.
 */
function openPrintWindow(html: string): void {
  if (typeof window === 'undefined') return;
  const w = window.open('', '_blank');
  if (!w) {
    window.alert(
      'Could not open the print window — your browser may have blocked the popup. Allow popups for this site and try again.',
    );
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

/** Format an ISO timestamp as dd/mm/yyyy HH:mm in local time. */
function fmtDateTimeFromTimestamp(iso: string): string {
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return '';
  const y = dt.getFullYear();
  const mo = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  const h = String(dt.getHours()).padStart(2, '0');
  const mi = String(dt.getMinutes()).padStart(2, '0');
  return `${d}/${mo}/${y} ${h}:${mi}`;
}

// ─── Component ───────────────────────────────────────────────

export function CalendarApp(props: CalendarAppProps) {
  const {
    horizon,
    activities,
    dayLoads,
    assembliesFetchedAt,
    kitchenActivityCount,
    kitchenRequiredCount,
    stationDailyMinutes,
    kitchenMinutesByProductCode,
    infeasibleProducts,
    routingDecisions,
    productOverrides,
    productStationDailyOutput,
    sohByProductCode,
    sohFetchedAt,
    availableWarehouses,
    eligibleWarehouses,
    initialInventoryByProduct,
    salesOrdersByProduct,
    committedByProduct,
    salesOrdersFetchedAt,
    totalSalesOrderLines,
    rawMaterialShortages,
    purchaseRequirements,
    vendorByCode,
    todayLocal,
    globalDefaults,
    horizonOptions,
    consumesMap,
    summary,
  } = props;
  const [infeasibleOpen, setInfeasibleOpen] = useState(false);

  // Re-plan: triggers Next.js to re-fetch the server component, which re-runs
  // the full pipeline against whatever's in the spreadsheet + demand.csv right
  // now. useTransition gives us isPending so we can show a loading indicator
  // while the server re-renders without blocking the UI.
  const router = useRouter();
  const [isReplanning, startReplan] = useTransition();
  function replan() {
    startReplan(() => {
      router.refresh();
    });
  }

  // SOH refresh: hit /api/refresh-soh to pull from Unleashed and write the
  // cache, then trigger a page re-render so the new initialInventory flows
  // through the optimiser.
  const [refreshingSoh, setRefreshingSoh] = useState(false);
  const [sohRefreshError, setSohRefreshError] = useState<string | null>(null);
  async function refreshSoh() {
    setRefreshingSoh(true);
    setSohRefreshError(null);
    try {
      const res = await fetch('/api/refresh-soh', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail ?? data.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (e) {
      setSohRefreshError(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setRefreshingSoh(false);
    }
  }

  // Sales-orders refresh: same shape as SOH refresh.
  const [refreshingSO, setRefreshingSO] = useState(false);
  const [soRefreshError, setSORefreshError] = useState<string | null>(null);
  async function refreshSalesOrders() {
    setRefreshingSO(true);
    setSORefreshError(null);
    try {
      const res = await fetch('/api/refresh-sales-orders', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail ?? data.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (e) {
      setSORefreshError(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setRefreshingSO(false);
    }
  }

  // Assemblies (kitchen production) refresh.
  const [refreshingAssemblies, setRefreshingAssemblies] = useState(false);
  const [assembliesRefreshError, setAssembliesRefreshError] = useState<string | null>(null);
  async function refreshAssemblies() {
    setRefreshingAssemblies(true);
    setAssembliesRefreshError(null);
    try {
      const res = await fetch('/api/refresh-assemblies', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail ?? data.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (e) {
      setAssembliesRefreshError(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setRefreshingAssemblies(false);
    }
  }

  // Layer-toggle state: which packaging stations are visible. Default all on.
  const [visibleStations, setVisibleStations] = useState<Set<Station>>(
    () => new Set(STATIONS),
  );
  // Top-level category toggles: packaging (chips for the four stations) and
  // kitchen (chips for Lundberg assemblies). Either off hides ALL activities
  // of that kind regardless of per-station toggles.
  const [showPackaging, setShowPackaging] = useState(true);
  const [showKitchen, setShowKitchen] = useState(true);
  // Sub-toggles within Kitchen: scheduled (live Unleashed) vs required
  // (planner-derived gaps). Default both on; kitchen master gates the lot.
  const [showKitchenScheduled, setShowKitchenScheduled] = useState(true);
  const [showKitchenRequired, setShowKitchenRequired] = useState(true);
  // Purchasing chips (Phase 4m.2): place-by and arrive-by chips for raw
  // materials projected to run short. Default on so the user sees them.
  const [showPO, setShowPO] = useState(true);

  // Selected activity for the drawer.
  const [selected, setSelected] = useState<CalendarActivity | null>(null);

  // ─── Mutations (dismiss) ─────────────────────────────────
  // Hydrated from localStorage on mount; written on every mutation.
  const [mutations, setMutations] = useState<MutationsMap>({});
  const [showDismissed, setShowDismissed] = useState(true);

  useEffect(() => {
    setMutations(readMutationsFromStorage());
  }, []);

  // Unplaceable chips from the most-recent Resolve-all run. Cleared by any
  // subsequent mutation (the situation has changed; the user should re-run
  // resolve to get a fresh verdict). Phase 4l.4.
  const [unplaceableIds, setUnplaceableIds] = useState<string[]>([]);

  // Mutation actions — every one writes through to localStorage immediately.
  function persist(next: MutationsMap) {
    writeMutationsToStorage(next);
    return next;
  }
  function dismiss(stableId: string) {
    setMutations((curr) => persist(applyDismiss(curr, stableId)));
    setUnplaceableIds([]);
  }
  function undismiss(stableId: string) {
    setMutations((curr) => persist(applyUndismiss(curr, stableId)));
    setUnplaceableIds([]);
  }
  function reschedule(stableId: string, newDate: string) {
    setMutations((curr) => persist(applyReschedule(curr, stableId, newDate)));
    setUnplaceableIds([]);
  }
  function clearReschedule(stableId: string) {
    setMutations((curr) => persist(applyClearReschedule(curr, stableId)));
    setUnplaceableIds([]);
  }
  function editQuantity(stableId: string, qty: number) {
    setMutations((curr) => persist(applyEditQuantity(curr, stableId, qty)));
    setUnplaceableIds([]);
  }
  function clearEdit(stableId: string) {
    setMutations((curr) => persist(applyClearEdit(curr, stableId)));
    setUnplaceableIds([]);
  }
  /** Edit lead time on a PO. Always passed the place-by chip's stableId. */
  function editLeadTime(placeByStableId: string, days: number) {
    setMutations((curr) => persist(applyEditLeadTime(curr, placeByStableId, days)));
    setUnplaceableIds([]);
  }
  function clearLeadTime(placeByStableId: string) {
    setMutations((curr) => persist(applyClearLeadTime(curr, placeByStableId)));
    setUnplaceableIds([]);
  }
  function clearStaleMutations() {
    setMutations((curr) => persist(clearStale(curr, validStableIds)));
    setUnplaceableIds([]);
  }

  /**
   * Auto-cascade conflict resolution (Phase 4l.3 + 4l.4 + 4l.6).
   *
   * Delegates to the pure `resolveScheduleConflicts` engine module. Wired
   * to two button pairs (banner + drawer), each offering both strategies:
   *
   *   - 'push': move consumers later (capacity-aware via stationDailyMinutes).
   *   - 'pull': move blocking suppliers earlier (floor at horizon.startWeek
   *     so we don't pull anything into the past).
   *
   * Both call the same function with a different `strategy` flag.
   */
  function resolveAllConflicts(strategy: ResolveStrategy) {
    const result = resolveScheduleConflicts({
      activities,
      mutations,
      consumesMap,
      strategy,
      stationDailyMinutes,
      // Kitchen team's 8-hour day, shared with the heatmap below so the
      // resolver and the user see the same load picture.
      kitchenDailyMinutes: KITCHEN_DAILY_MINUTES,
      kitchenStartMinutesByProductCode: kitchenMinutesByProductCode,
      kitchenStartMinutesDefault: KITCHEN_DEFAULT_CHIP_MINUTES,
      // Pull-supplier floor: never pull a chip earlier than the planning
      // horizon's first day. (For 'push' this argument is ignored.)
      earliestDate: horizon.startWeek,
    });
    setMutations(persist(result.mutations));
    setUnplaceableIds(result.unplaceableStableIds);
  }

  // Set of stable IDs in the current engine output — used to detect stale
  // mutation entries (entries whose activity no longer exists in the plan).
  // Includes PO chip stableIds so lead-time overrides aren't flagged stale.
  const validStableIds = useMemo(() => {
    const out = new Set(activities.map((a) => a.stableId));
    for (const r of purchaseRequirements) {
      out.add(`po-placed|${r.rawMaterialCode}`);
      out.add(`po-receiving|${r.rawMaterialCode}`);
    }
    return out;
  }, [activities, purchaseRequirements]);

  const staleIds = useMemo(
    () => staleStableIds(mutations, validStableIds),
    [mutations, validStableIds],
  );

  // PO chips are projected client-side (Phase 4m.4) so user-set lead-time
  // overrides flow through naturally via the mutations map. Built before
  // applying mutations so subsequent steps can reschedule/dismiss them.
  const poChips = useMemo<CalendarActivity[]>(() => {
    return projectPoChips({
      purchaseRequirements,
      today: todayLocal,
      leadTimeOverrideDaysByCode: leadTimeOverridesByCode(mutations),
      vendorByCode,
    });
  }, [purchaseRequirements, todayLocal, mutations, vendorByCode]);

  // Combined activities = server-side (packaging + kitchen + kitchen-required)
  // + client-projected PO chips.
  const activitiesWithPo = useMemo<CalendarActivity[]>(() => {
    return [...activities, ...poChips].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
  }, [activities, poChips]);

  // Apply mutations to each activity: override date if rescheduled, override
  // quantity if edited (with proportional duration + finishDate adjustment).
  // Dismiss is applied later by the visibility filter.
  //
  // The projection logic itself lives in `calendar-mutations` so the engine
  // resolver can use the same code path; here we just memoise the result.
  const mutatedActivities = useMemo(() => {
    return applyMutationsToActivities(activitiesWithPo, mutations);
  }, [activitiesWithPo, mutations]);

  // Number of dismissed activities present in the current plan.
  const dismissedCount = useMemo(
    () => activities.filter((a) => isDismissed(mutations, a.stableId)).length,
    [activities, mutations],
  );

  // Schedule conflicts: re-detect on every mutation change so dragging a
  // chip immediately surfaces (or clears) downstream dependency breaks.
  const conflicts = useMemo<ScheduleConflict[]>(() => {
    const dismissedSet = new Set<string>();
    for (const a of activities) {
      if (isDismissed(mutations, a.stableId)) dismissedSet.add(a.stableId);
    }
    return detectScheduleConflicts({
      activities: mutatedActivities,
      consumesMap,
      dismissedStableIds: dismissedSet,
    });
  }, [mutatedActivities, consumesMap, mutations, activities]);

  // Index conflicts by stableId for fast chip-render lookup. A consumer can
  // have multiple conflicts (one per missing ingredient).
  const conflictsByConsumer = useMemo(() => {
    const out = new Map<string, ScheduleConflict[]>();
    for (const c of conflicts) {
      let arr = out.get(c.consumerStableId);
      if (!arr) {
        arr = [];
        out.set(c.consumerStableId, arr);
      }
      arr.push(c);
    }
    return out;
  }, [conflicts]);

  // ─── Hover-arrow relationship map (Phase 4l.5) ──────────────
  // For every activity, what other activities supply or consume it. Used by
  // the calendar to draw dependency arrows when the user hovers a chip.
  //
  // Two filters apply, both of which match the conflict-detector semantics
  // so the arrows match what the planner considers a "real" relationship:
  //   1. Dismissed chips don't appear (dropped on either side).
  //   2. **Temporal feasibility**: a supplier S is only a real supplier of
  //      consumer C when S.finishDate < C.date (the 1-day buffer rule).
  //      Without this filter we'd draw arrows from kitchen runs to packaging
  //      chips that are actually too early to use them — e.g. a 5/15 IMK run
  //      "supplying" a 5/8 packaging chip purely because they share the
  //      product-code relationship in the BOM.
  //
  // The filter is applied on each (consumer, supplier) PAIR, not per chip,
  // so the same supplier may appear for some consumers and not others.
  type RelKind = 'supplier' | 'consumer';
  interface RelEntry { stableId: string; kind: RelKind; }
  const relatedByStableId = useMemo<Map<string, RelEntry[]>>(() => {
    // Group non-dismissed activities by productCode for O(1) supplier lookup.
    const byProductCode = new Map<string, CalendarActivity[]>();
    for (const a of mutatedActivities) {
      if (isDismissed(mutations, a.stableId)) continue;
      let arr = byProductCode.get(a.productCode);
      if (!arr) { arr = []; byProductCode.set(a.productCode, arr); }
      arr.push(a);
    }
    // Build the inverse consumesMap: ingredient → list of parent codes that
    // consume it. Lets us find consumers without scanning every chip.
    const consumedBy = new Map<string, string[]>();
    for (const [parent, ingredients] of Object.entries(consumesMap)) {
      for (const ing of ingredients) {
        let arr = consumedBy.get(ing);
        if (!arr) { arr = []; consumedBy.set(ing, arr); }
        arr.push(parent);
      }
    }
    /** Mirrors `finishDateOf` in schedule-conflicts.ts. */
    const finishOf = (a: CalendarActivity) => a.finishDate ?? a.date;
    const out = new Map<string, RelEntry[]>();
    for (const a of mutatedActivities) {
      if (isDismissed(mutations, a.stableId)) continue;
      const rels: RelEntry[] = [];
      // Suppliers — chips whose productCode is one of `a`'s ingredients
      // AND whose finishDate strictly precedes `a`'s date (1-day buffer).
      for (const ing of consumesMap[a.productCode] ?? []) {
        for (const s of byProductCode.get(ing) ?? []) {
          if (s.stableId === a.stableId) continue;
          if (finishOf(s) < a.date) {
            rels.push({ stableId: s.stableId, kind: 'supplier' });
          }
        }
      }
      // Consumers — chips whose product consumes `a.productCode` AND whose
      // date is strictly AFTER `a`'s finish.
      const aFinish = finishOf(a);
      for (const parent of consumedBy.get(a.productCode) ?? []) {
        for (const c of byProductCode.get(parent) ?? []) {
          if (c.stableId === a.stableId) continue;
          if (aFinish < c.date) {
            rels.push({ stableId: c.stableId, kind: 'consumer' });
          }
        }
      }
      if (rels.length > 0) out.set(a.stableId, rels);
    }
    return out;
  }, [mutatedActivities, mutations, consumesMap]);

  // Currently-hovered chip — drives arrow drawing. null = no arrows.
  const [hoveredStableId, setHoveredStableId] = useState<string | null>(null);
  const onChipHover = useCallback((id: string | null) => {
    setHoveredStableId(id);
  }, []);

  // Fast lookup for chips that the most-recent Resolve-all left unplaced.
  const unplaceableSet = useMemo(
    () => new Set(unplaceableIds),
    [unplaceableIds],
  );

  // Filter mutated activities through layer toggles + dismissal visibility.
  const visibleActivities = useMemo(() => {
    return mutatedActivities.filter((a) => {
      // Category toggle (top-level): Packaging master / Kitchen master.
      if (a.kind === 'packaging' && !showPackaging) return false;
      if (a.kind === 'kitchen' && (!showKitchen || !showKitchenScheduled)) return false;
      if (a.kind === 'kitchen-required' && (!showKitchen || !showKitchenRequired)) return false;
      // PO toggle: hides BOTH placed and receiving chips together.
      if ((a.kind === 'po-placed' || a.kind === 'po-receiving') && !showPO) return false;
      // Per-station toggle within packaging
      if (a.kind === 'packaging' && a.station && !visibleStations.has(a.station)) return false;
      if (!showDismissed && isDismissed(mutations, a.stableId)) return false;
      return true;
    });
  }, [
    mutatedActivities,
    visibleStations,
    showPackaging,
    showKitchen,
    showKitchenScheduled,
    showKitchenRequired,
    showPO,
    mutations,
    showDismissed,
  ]);
  const activitiesByDate = useMemo(
    () => groupByDate(visibleActivities),
    [visibleActivities],
  );

  // Aggregate per-day load across visible stations, EXCLUDING dismissed
  // activities and using the MUTATED activities (so reschedule and edit
  // both flow through to the badges).
  const peakLoadByDate = useMemo(() => {
    type Bucket = { usedMinutes: number; capacityMinutes: number; station: Station };
    const perDayPerStation = new Map<string, Map<Station, number>>();
    for (const a of mutatedActivities) {
      // Load is a packaging-station concept; kitchen activities don't have
      // a station capacity in this model.
      if (a.kind !== 'packaging' || !a.station) continue;
      if (!showPackaging) continue;
      if (!visibleStations.has(a.station)) continue;
      if (isDismissed(mutations, a.stableId)) continue;
      let stationMap = perDayPerStation.get(a.date);
      if (!stationMap) {
        stationMap = new Map();
        perDayPerStation.set(a.date, stationMap);
      }
      stationMap.set(
        a.station,
        (stationMap.get(a.station) ?? 0) + a.durationMinutes + a.changeoverMinutes,
      );
    }
    const out = new Map<string, Bucket & { utilisation: number }>();
    for (const [date, stationMap] of perDayPerStation.entries()) {
      let peak: (Bucket & { utilisation: number }) | null = null;
      for (const [station, used] of stationMap.entries()) {
        const cap = stationDailyMinutes[station] ?? 480;
        const util = cap > 0 ? used / cap : 0;
        if (!peak || util > peak.utilisation) {
          peak = { usedMinutes: used, capacityMinutes: cap, station, utilisation: util };
        }
      }
      if (peak) out.set(date, peak);
    }
    return out;
  }, [mutatedActivities, visibleStations, showPackaging, mutations, stationDailyMinutes]);

  // Per-day kitchen-team load (Phase 4l.7 + 4l.8 per-recipe). Mirrors the
  // kitchen capacity model the resolver uses: each kitchen-required chip
  // costs `kitchenMinutesByProductCode[code] ?? KITCHEN_DEFAULT_CHIP_MINUTES`
  // on its start day. Respects the kitchen visibility toggles so hiding
  // kitchen-required chips clears their load contribution.
  const kitchenLoadByDate = useMemo(() => {
    const out = new Map<string, { usedMinutes: number; capacityMinutes: number; utilisation: number }>();
    if (!showKitchen || !showKitchenRequired) return out;
    const used = new Map<string, number>();
    for (const a of mutatedActivities) {
      if (a.kind !== 'kitchen-required') continue;
      if (isDismissed(mutations, a.stableId)) continue;
      const cost = kitchenMinutesByProductCode[a.productCode] ?? KITCHEN_DEFAULT_CHIP_MINUTES;
      used.set(a.date, (used.get(a.date) ?? 0) + cost);
    }
    for (const [date, mins] of used.entries()) {
      out.set(date, {
        usedMinutes: mins,
        capacityMinutes: KITCHEN_DAILY_MINUTES,
        utilisation: KITCHEN_DAILY_MINUTES > 0 ? mins / KITCHEN_DAILY_MINUTES : 0,
      });
    }
    return out;
  }, [mutatedActivities, mutations, showKitchen, showKitchenRequired, kitchenMinutesByProductCode]);

  // Per-station counts (for the chip labels in the rail) — count BEFORE
  // filtering so the user can see what they'd un-hide. Kitchen activities
  // (station=null) don't contribute to packaging-station counts.
  const stationCounts = useMemo(() => {
    const counts: Record<Station, number> = {
      'hand-packing': 0,
      elephant: 0,
      dust: 0,
      bottlo: 0,
    };
    for (const a of activities) {
      if (a.kind === 'packaging' && a.station) counts[a.station] += 1;
    }
    return counts;
  }, [activities]);

  // Build the date grid: full horizon as a flat list, grouped by week and month.
  const dates = useMemo(
    () => horizonDates(horizon.startWeek, horizon.weeks),
    [horizon],
  );

  // Per-week per-station utilisation, from mutated activities. Used by the
  // capacity heatmap panel below the calendar. For each (week, station)
  // we surface the PEAK day utilisation in that week (overruns are what
  // matter most operationally); the tooltip shows the weekly total minutes.
  // The kitchen row is computed alongside using the same constants the
  // resolver uses (one source of truth for kitchen load).
  const heatmapByWeek = useMemo(() => {
    type Cell = { peakUtilisation: number; totalMinutes: number };
    const usedByDateStation = new Map<string, Map<Station, number>>();
    const usedByDateKitchen = new Map<string, number>();
    for (const a of mutatedActivities) {
      if (isDismissed(mutations, a.stableId)) continue;
      if (a.kind === 'packaging' && a.station) {
        let stMap = usedByDateStation.get(a.date);
        if (!stMap) {
          stMap = new Map();
          usedByDateStation.set(a.date, stMap);
        }
        stMap.set(a.station, (stMap.get(a.station) ?? 0) + a.durationMinutes + a.changeoverMinutes);
      } else if (a.kind === 'kitchen-required') {
        const cost = kitchenMinutesByProductCode[a.productCode] ?? KITCHEN_DEFAULT_CHIP_MINUTES;
        usedByDateKitchen.set(
          a.date,
          (usedByDateKitchen.get(a.date) ?? 0) + cost,
        );
      }
    }
    const weekStarts: string[] = [];
    {
      const start = fromISO(horizon.startWeek);
      for (let i = 0; i < horizon.weeks; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i * 7);
        weekStarts.push(toISO(d));
      }
    }
    const out = new Map<string, Map<Station, Cell>>();
    const kitchenByWeek = new Map<string, Cell>();
    for (const ws of weekStarts) {
      const stationMap = new Map<Station, Cell>();
      const days: string[] = [];
      const monday = fromISO(ws);
      for (let i = 0; i < 5; i++) {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        days.push(toISO(d));
      }
      for (const station of STATIONS) {
        let peakUtil = 0;
        let totalMin = 0;
        const cap = stationDailyMinutes[station] ?? 480;
        for (const d of days) {
          const used = usedByDateStation.get(d)?.get(station) ?? 0;
          totalMin += used;
          const util = cap > 0 ? used / cap : 0;
          if (util > peakUtil) peakUtil = util;
        }
        stationMap.set(station, { peakUtilisation: peakUtil, totalMinutes: totalMin });
      }
      // Kitchen-team row: peak day utilisation across the working week.
      let kPeak = 0;
      let kTotal = 0;
      for (const d of days) {
        const used = usedByDateKitchen.get(d) ?? 0;
        kTotal += used;
        const util = KITCHEN_DAILY_MINUTES > 0 ? used / KITCHEN_DAILY_MINUTES : 0;
        if (util > kPeak) kPeak = util;
      }
      kitchenByWeek.set(ws, { peakUtilisation: kPeak, totalMinutes: kTotal });
    }
    return { weekStarts, byWeek: out, kitchenByWeek };
  }, [mutatedActivities, mutations, horizon, stationDailyMinutes, kitchenMinutesByProductCode]);

  // Group dates into months for section headers.
  const monthGroups = useMemo(() => {
    const groups: { monthKey: string; label: string; dates: string[] }[] = [];
    let currentKey: string | null = null;
    for (const iso of dates) {
      const d = fromISO(iso);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (key !== currentKey) {
        groups.push({ monthKey: key, label: fmtMonthYear(iso), dates: [] });
        currentKey = key;
      }
      groups[groups.length - 1].dates.push(iso);
    }
    return groups;
  }, [dates]);

  function toggleStation(s: Station) {
    setVisibleStations((curr) => {
      const next = new Set(curr);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  return (
    // align-items: flex-start lets the sticky children opt out of being
    // stretched to the parent's full height (default `stretch` would defeat
    // sticky). The rails then anchor at top of viewport (offset by the
    // page's sticky header) and scroll internally if their content exceeds
    // the viewport.
    <div
      style={{
        display: 'flex',
        minHeight: 'calc(100vh - 130px)',
        alignItems: 'flex-start',
      }}
    >
      {/* ─── Left rail ─────────────────────────────────── */}
      <aside
        style={{
          width: 260,
          padding: 16,
          borderRight: '0.5px solid var(--border)',
          background: 'var(--bg-surface)',
          flexShrink: 0,
          position: 'sticky',
          top: 60, // sits below the layout's sticky nav header
          maxHeight: 'calc(100vh - 60px)',
          overflowY: 'auto',
          alignSelf: 'flex-start',
        }}
      >
        <Section title="Plan summary">
          <KPIRow label="Products" value={`${summary.productCount}`} />
          <KPIRow
            label="Feasible"
            value={`${summary.feasibleCount}`}
            tone={summary.infeasibleCount > 0 ? 'amber' : 'green'}
          />
          {summary.infeasibleCount > 0 && (
            <KPIRow
              label="Infeasible"
              value={`${summary.infeasibleCount}`}
              tone="red"
            />
          )}
          <KPIRow
            label="Changeover (total)"
            value={`${Math.round(summary.totalChangeoverMinutes)} min`}
          />
          <KPIRow label="Activities" value={`${activities.length}`} />
        </Section>

        <Section title="Layers">
          {/* Category-level toggles: Packaging master + Kitchen master. */}
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 0',
              fontSize: 13,
              cursor: 'pointer',
              opacity: showPackaging ? 1 : 0.4,
              userSelect: 'none',
              fontWeight: 500,
            }}
          >
            <input
              type="checkbox"
              checked={showPackaging}
              onChange={() => setShowPackaging((v) => !v)}
            />
            <span style={{ flex: 1 }}>Packaging</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
              {Object.values(stationCounts).reduce((s, n) => s + n, 0)}
            </span>
          </label>

          {/* Per-station detail toggles within Packaging — indented; greyed
              when the master Packaging toggle is off. */}
          <div
            style={{
              paddingLeft: 18,
              opacity: showPackaging ? 1 : 0.5,
              pointerEvents: showPackaging ? 'auto' : 'none',
            }}
          >
            {STATIONS.map((s) => {
              const on = visibleStations.has(s);
              const colors = STATION_COLORS[s];
              return (
                <label
                  key={s}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '4px 0',
                    fontSize: 12,
                    cursor: 'pointer',
                    opacity: on ? 1 : 0.4,
                    userSelect: 'none',
                  }}
                >
                  <input type="checkbox" checked={on} onChange={() => toggleStation(s)} />
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: colors.dot,
                      display: 'inline-block',
                    }}
                  />
                  <span style={{ flex: 1 }}>{STATION_LABELS[s]}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                    {stationCounts[s]}
                  </span>
                </label>
              );
            })}
          </div>

          {/* Kitchen master toggle, with two sub-toggles for scheduled
              (live Unleashed) vs required (planner-derived gaps). */}
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 0',
              marginTop: 4,
              fontSize: 13,
              cursor: 'pointer',
              opacity: showKitchen ? 1 : 0.4,
              userSelect: 'none',
              fontWeight: 500,
            }}
          >
            <input
              type="checkbox"
              checked={showKitchen}
              onChange={() => setShowKitchen((v) => !v)}
            />
            <span style={{ flex: 1 }}>Kitchen</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
              {kitchenActivityCount + kitchenRequiredCount}
            </span>
          </label>
          <div
            style={{
              paddingLeft: 18,
              opacity: showKitchen ? 1 : 0.5,
              pointerEvents: showKitchen ? 'auto' : 'none',
            }}
          >
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 0',
                fontSize: 12,
                cursor: 'pointer',
                opacity: showKitchenScheduled ? 1 : 0.4,
                userSelect: 'none',
              }}
            >
              <input
                type="checkbox"
                checked={showKitchenScheduled}
                onChange={() => setShowKitchenScheduled((v) => !v)}
              />
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: KITCHEN_COLOR.dot,
                  display: 'inline-block',
                }}
              />
              <span style={{ flex: 1 }}>Scheduled</span>
              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                {kitchenActivityCount}
              </span>
            </label>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 0',
                fontSize: 12,
                cursor: 'pointer',
                opacity: showKitchenRequired ? 1 : 0.4,
                userSelect: 'none',
              }}
            >
              <input
                type="checkbox"
                checked={showKitchenRequired}
                onChange={() => setShowKitchenRequired((v) => !v)}
              />
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: KITCHEN_REQUIRED_COLOR.dot,
                  display: 'inline-block',
                }}
              />
              <span style={{ flex: 1 }}>Required (planner)</span>
              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                {kitchenRequiredCount}
              </span>
            </label>
          </div>
          {/* Purchasing toggle (Phase 4m.2). Single master switch — both
              place-by and arrive-by chips toggle together. The count is
              the requirement count (one PO per material). */}
          {purchaseRequirements.length > 0 && (
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 0',
                marginTop: 4,
                fontSize: 13,
                cursor: 'pointer',
                opacity: showPO ? 1 : 0.4,
                userSelect: 'none',
                fontWeight: 500,
              }}
            >
              <input
                type="checkbox"
                checked={showPO}
                onChange={() => setShowPO((v) => !v)}
              />
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: PO_PLACED_COLOR.dot,
                  display: 'inline-block',
                }}
              />
              <span style={{ flex: 1 }}>Purchasing</span>
              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                {purchaseRequirements.length}
              </span>
            </label>
          )}
          {dismissedCount > 0 && (
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 0',
                fontSize: 13,
                cursor: 'pointer',
                userSelect: 'none',
                marginTop: 4,
                paddingTop: 8,
                borderTop: '0.5px solid var(--border)',
              }}
            >
              <input
                type="checkbox"
                checked={showDismissed}
                onChange={() => setShowDismissed((v) => !v)}
              />
              <span style={{ flex: 1, color: 'var(--text-muted)' }}>Show dismissed</span>
              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                {dismissedCount}
              </span>
            </label>
          )}
        </Section>

        {infeasibleProducts.length > 0 && (
          <Section title={`Infeasible (${infeasibleProducts.length})`}>
            <button
              type="button"
              onClick={() => setInfeasibleOpen((v) => !v)}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '6px 8px',
                fontSize: 12,
                background: '#fef2f2',
                color: '#991b1b',
                border: '0.5px solid #fecaca',
                borderRadius: 4,
                cursor: 'pointer',
                marginBottom: 6,
                fontFamily: 'inherit',
              }}
            >
              {infeasibleOpen ? '▾' : '▸'} {infeasibleProducts.length} products couldn't be scheduled
            </button>
            {infeasibleOpen && (
              <ul
                style={{
                  listStyle: 'none',
                  padding: 0,
                  margin: 0,
                  maxHeight: 280,
                  overflowY: 'auto',
                  fontSize: 11,
                }}
              >
                {infeasibleProducts.map((p) => (
                  <li
                    key={p.productCode}
                    style={{
                      padding: '6px 0',
                      borderBottom: '0.5px solid var(--border)',
                    }}
                    title={p.reason}
                  >
                    <div style={{ fontWeight: 500 }}>{p.productCode}</div>
                    <div style={{ color: 'var(--text-muted)' }}>
                      {p.station} • unmet ≈ {p.unmetUnits} units
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}

        <Section title="Reports">
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.4 }}>
            Each report reflects the current plan with your edits applied.
            Print opens a formatted view; CSV opens in Excel.
          </div>
          {/* Build the driver lookup once so both PO buttons share it. */}
          {(() => {
            const driverLookup = new Map(
              activitiesWithPo.map((a) => [
                a.stableId,
                { productCode: a.productCode, productName: a.productName, date: a.date },
              ]),
            );
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {/* PO row */}
                <ReportRow
                  label={`Purchase orders (${purchaseRequirements.length})`}
                  enabled={purchaseRequirements.length > 0}
                  onPrint={() =>
                    openPrintWindow(
                      buildPoHtml({
                        purchaseRequirements,
                        vendorByCode,
                        mutations,
                        today: todayLocal,
                        driverLookup,
                      }),
                    )
                  }
                  onCsv={() =>
                    downloadCsv(
                      buildPoCsv({
                        purchaseRequirements,
                        vendorByCode,
                        mutations,
                        today: todayLocal,
                        driverLookup,
                      }),
                      `byron-po-plan-${todayLocal}.csv`,
                    )
                  }
                />
                <ReportRow
                  label="Packaging schedule"
                  enabled
                  onPrint={() =>
                    openPrintWindow(
                      buildPackagingHtml({
                        activities: mutatedActivities,
                        mutations,
                        stationDailyMinutes,
                        today: todayLocal,
                      }),
                    )
                  }
                  onCsv={() =>
                    downloadCsv(
                      buildPackagingCsv({
                        activities: mutatedActivities,
                        mutations,
                        stationDailyMinutes,
                      }),
                      `byron-packaging-plan-${todayLocal}.csv`,
                    )
                  }
                />
                <ReportRow
                  label={`Kitchen runs (${kitchenRequiredCount})`}
                  enabled={kitchenRequiredCount > 0}
                  onPrint={() =>
                    openPrintWindow(
                      buildKitchenHtml({
                        activities: mutatedActivities,
                        mutations,
                        kitchenMinutesByProductCode,
                        kitchenDefaultMinutes: KITCHEN_DEFAULT_CHIP_MINUTES,
                        today: todayLocal,
                      }),
                    )
                  }
                  onCsv={() =>
                    downloadCsv(
                      buildKitchenCsv({
                        activities: mutatedActivities,
                        mutations,
                        kitchenMinutesByProductCode,
                        kitchenDefaultMinutes: KITCHEN_DEFAULT_CHIP_MINUTES,
                      }),
                      `byron-kitchen-plan-${todayLocal}.csv`,
                    )
                  }
                />
              </div>
            );
          })()}
        </Section>

        <Section title="Data">
          <KPIRow
            label="Demand source"
            value={summary.demandSourceMtime ? fmtDateFromTimestamp(summary.demandSourceMtime) : '—'}
          />
          <KPIRow
            label="SOH refreshed"
            value={
              sohFetchedAt
                ? fmtDateTimeFromTimestamp(sohFetchedAt)
                : 'never'
            }
            tone={sohFetchedAt ? undefined : 'amber'}
          />
          <KPIRow
            label="Sales orders"
            value={
              salesOrdersFetchedAt
                ? `${totalSalesOrderLines} lines · ${fmtDateTimeFromTimestamp(salesOrdersFetchedAt)}`
                : 'never'
            }
            tone={salesOrdersFetchedAt ? undefined : 'amber'}
          />
          <KPIRow
            label="Kitchen assemblies"
            value={
              assembliesFetchedAt
                ? `${kitchenActivityCount} runs · ${fmtDateTimeFromTimestamp(assembliesFetchedAt)}`
                : 'never'
            }
            tone={assembliesFetchedAt ? undefined : 'amber'}
          />
          {availableWarehouses.length > 0 && (
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
              <div style={{ marginBottom: 2 }}>Eligible warehouses (sum):</div>
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {eligibleWarehouses.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
              {availableWarehouses.some((w) => !eligibleWarehouses.includes(w)) && (
                <div style={{ marginTop: 4 }}>
                  Excluded:{' '}
                  {availableWarehouses
                    .filter((w) => !eligibleWarehouses.includes(w))
                    .join(', ')}
                </div>
              )}
            </div>
          )}
          {(summary.orchestratorWarningCount + summary.dayAssignerWarningCount + summary.capacityWarningCount) > 0 && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
              Warnings: {summary.capacityWarningCount} loader,{' '}
              {summary.orchestratorWarningCount} planner,{' '}
              {summary.dayAssignerWarningCount} day-assigner
            </div>
          )}
        </Section>
      </aside>

      {/* ─── Main calendar ─────────────────────────────── */}
      <main style={{ flex: 1, padding: 24, overflowX: 'auto' }}>
        <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>Production Calendar</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-muted)' }}>
              <span>Horizon:</span>
              <select
                value={horizon.weeks}
                onChange={(e) => {
                  const url = new URL(window.location.href);
                  url.searchParams.set('horizonWeeks', e.target.value);
                  window.location.assign(url.toString());
                }}
                disabled={isReplanning || refreshingSoh}
                style={{
                  padding: '4px 6px',
                  fontSize: 12,
                  border: '0.5px solid var(--border)',
                  borderRadius: 3,
                  background: 'var(--bg-page)',
                  color: 'inherit',
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                {horizonOptions.map((weeks) => (
                  <option key={weeks} value={weeks}>
                    {weeks} weeks {weeks === 26 ? '(6 mo)' : weeks === 12 ? '(3 mo)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              from {fmtDate(horizon.startWeek)}
            </span>
            <button
              type="button"
              onClick={refreshSoh}
              disabled={refreshingSoh || refreshingSO || isReplanning}
              style={{
                padding: '6px 12px',
                fontSize: 13,
                background: 'var(--bg-page)',
                color: 'inherit',
                border: '0.5px solid var(--border)',
                borderRadius: 4,
                cursor: refreshingSoh ? 'wait' : 'pointer',
                fontFamily: 'inherit',
              }}
              title="Pull current stock-on-hand from Unleashed and re-plan"
            >
              {refreshingSoh ? 'Refreshing SOH…' : 'Refresh SOH'}
            </button>
            <button
              type="button"
              onClick={refreshSalesOrders}
              disabled={refreshingSoh || refreshingSO || refreshingAssemblies || isReplanning}
              style={{
                padding: '6px 12px',
                fontSize: 13,
                background: 'var(--bg-page)',
                color: 'inherit',
                border: '0.5px solid var(--border)',
                borderRadius: 4,
                cursor: refreshingSO ? 'wait' : 'pointer',
                fontFamily: 'inherit',
              }}
              title="Pull active customer sales orders from Unleashed and re-plan"
            >
              {refreshingSO ? 'Refreshing SO…' : 'Refresh SO'}
            </button>
            <button
              type="button"
              onClick={refreshAssemblies}
              disabled={refreshingSoh || refreshingSO || refreshingAssemblies || isReplanning}
              style={{
                padding: '6px 12px',
                fontSize: 13,
                background: 'var(--bg-page)',
                color: 'inherit',
                border: '0.5px solid var(--border)',
                borderRadius: 4,
                cursor: refreshingAssemblies ? 'wait' : 'pointer',
                fontFamily: 'inherit',
              }}
              title="Pull active kitchen assemblies from Unleashed"
            >
              {refreshingAssemblies ? 'Refreshing kitchen…' : 'Refresh kitchen'}
            </button>
            <button
              type="button"
              onClick={replan}
              disabled={isReplanning || refreshingSoh}
              style={{
                padding: '6px 14px',
                fontSize: 13,
                background: isReplanning ? 'var(--bg-page)' : 'var(--accent, #1e40af)',
                color: isReplanning ? 'var(--text-muted)' : 'white',
                border: '0.5px solid var(--border)',
                borderRadius: 4,
                cursor: isReplanning ? 'wait' : 'pointer',
                fontFamily: 'inherit',
                fontWeight: 500,
              }}
              title="Re-run the pipeline with the latest spreadsheet + demand.csv"
            >
              {isReplanning ? 'Re-planning…' : 'Re-plan'}
            </button>
          </div>
        </div>

        {sohRefreshError && (
          <div
            style={{
              marginBottom: 16,
              padding: '8px 12px',
              background: '#fef2f2',
              border: '0.5px solid #fecaca',
              borderRadius: 4,
              fontSize: 12,
              color: '#991b1b',
            }}
          >
            ⚠ SOH refresh failed: {sohRefreshError}
          </div>
        )}
        {soRefreshError && (
          <div
            style={{
              marginBottom: 16,
              padding: '8px 12px',
              background: '#fef2f2',
              border: '0.5px solid #fecaca',
              borderRadius: 4,
              fontSize: 12,
              color: '#991b1b',
            }}
          >
            ⚠ Sales-order refresh failed: {soRefreshError}
          </div>
        )}
        {assembliesRefreshError && (
          <div
            style={{
              marginBottom: 16,
              padding: '8px 12px',
              background: '#fef2f2',
              border: '0.5px solid #fecaca',
              borderRadius: 4,
              fontSize: 12,
              color: '#991b1b',
            }}
          >
            ⚠ Kitchen-assemblies refresh failed: {assembliesRefreshError}
          </div>
        )}

        {conflicts.length > 0 && (
          <div
            style={{
              marginBottom: 16,
              padding: '10px 12px',
              background: '#fef2f2',
              border: '0.5px solid #fecaca',
              borderRadius: 4,
              fontSize: 12,
              color: '#991b1b',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <span style={{ flex: 1 }}>
              ⚠ {conflicts.length} schedule conflict{conflicts.length === 1 ? '' : 's'} —
              {' '}an activity needs an ingredient that won't be ready in time.
              Drag the affected chips earlier, or move the upstream chip to finish sooner.
              Click a chip with a red border for details.
            </span>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <button
                type="button"
                onClick={() => resolveAllConflicts('auto')}
                title="Try to PULL each blocking kitchen run earlier; for any conflict that can't be pulled (floored at the planning-horizon start, or kitchen capacity full), PUSH the consumer later instead. The natural 'just fix it' option."
                style={{
                  padding: '5px 12px',
                  fontSize: 11,
                  background: '#dc2626',
                  color: '#fff',
                  border: '0.5px solid #b91c1c',
                  borderRadius: 3,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                }}
              >
                Resolve all (auto)
              </button>
              <button
                type="button"
                onClick={() => resolveAllConflicts('pull')}
                title="PULL every blocking ingredient run earlier so it finishes in time. Floored at the planning-horizon start and respects kitchen-team capacity (8 hrs/day); if floored, the chip is reported as unplaceable."
                style={{
                  padding: '4px 8px',
                  fontSize: 10,
                  background: '#fee2e2',
                  color: '#991b1b',
                  border: '0.5px solid #fecaca',
                  borderRadius: 3,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                }}
              >
                ← Pull only
              </button>
              <button
                type="button"
                onClick={() => resolveAllConflicts('push')}
                title="PUSH every conflicted activity later to its earliest feasible date. Respects per-station and kitchen-team capacity."
                style={{
                  padding: '4px 8px',
                  fontSize: 10,
                  background: '#fee2e2',
                  color: '#991b1b',
                  border: '0.5px solid #fecaca',
                  borderRadius: 3,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                }}
              >
                Push only →
              </button>
            </div>
          </div>
        )}

        {unplaceableIds.length > 0 && (
          <div
            style={{
              marginBottom: 16,
              padding: '10px 12px',
              background: '#fffbeb',
              border: '0.5px solid #fcd34d',
              borderRadius: 4,
              fontSize: 12,
              color: '#78350f',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <span style={{ flex: 1 }}>
              ⚠ {unplaceableIds.length} chip{unplaceableIds.length === 1 ? '' : 's'} couldn't
              be auto-placed — no working day with capacity within the search horizon. Try
              moving them manually, freeing capacity on a downstream day, or dismissing
              the activity.
              {' '}
              <span style={{ color: '#92400e' }}>
                ({unplaceableIds.slice(0, 3).map((id) => id.split('|')[0]).join(', ')}
                {unplaceableIds.length > 3 ? `, +${unplaceableIds.length - 3} more` : ''})
              </span>
            </span>
            <button
              type="button"
              onClick={() => setUnplaceableIds([])}
              title="Clear this notice (the chips remain unmoved)."
              style={{
                padding: '4px 10px',
                fontSize: 11,
                background: '#fef3c7',
                color: '#78350f',
                border: '0.5px solid #fcd34d',
                borderRadius: 3,
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontWeight: 500,
                whiteSpace: 'nowrap',
              }}
            >
              Dismiss
            </button>
          </div>
        )}

        {staleIds.length > 0 && (
          <div
            style={{
              marginBottom: 16,
              padding: '10px 12px',
              background: '#fffbeb',
              border: '0.5px solid #fcd34d',
              borderRadius: 4,
              fontSize: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              color: '#78350f',
            }}
          >
            <span style={{ flex: 1 }}>
              ⚠ {staleIds.length} stale mutation{staleIds.length === 1 ? '' : 's'} —
              the underlying activities are no longer in the plan (data changed since
              the mutation was made).
            </span>
            <button
              type="button"
              onClick={clearStaleMutations}
              style={{
                padding: '4px 10px',
                fontSize: 11,
                background: '#fef3c7',
                color: '#78350f',
                border: '0.5px solid #fcd34d',
                borderRadius: 3,
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontWeight: 500,
              }}
            >
              Clear stale
            </button>
          </div>
        )}

        {monthGroups.map((group) => (
          <MonthBlock
            key={group.monthKey}
            label={group.label}
            dates={group.dates}
            activitiesByDate={activitiesByDate}
            peakLoadByDate={peakLoadByDate}
            kitchenLoadByDate={kitchenLoadByDate}
            onSelect={setSelected}
            selectedId={selected?.id ?? null}
            mutations={mutations}
            conflictsByConsumer={conflictsByConsumer}
            unplaceableSet={unplaceableSet}
            hoveredStableId={hoveredStableId}
            onChipHover={onChipHover}
            relatedByStableId={relatedByStableId}
            onDropOnDate={(stableId, date) => {
              // No-op when dropped on the same day the activity is already on.
              const found = mutatedActivities.find((a) => a.stableId === stableId);
              if (!found || found.date === date) return;
              reschedule(stableId, date);
            }}
          />
        ))}

        {visibleActivities.length === 0 && (
          <div
            style={{
              padding: 40,
              textAlign: 'center',
              color: 'var(--text-muted)',
              border: '0.5px dashed var(--border)',
              borderRadius: 6,
              marginTop: 16,
            }}
          >
            No activities to show. Toggle a layer back on, or check that your demand data is loaded.
          </div>
        )}

        {/* ─── Bottom strip: heatmap + stockout risk ────── */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 1fr',
            gap: 16,
            marginTop: 24,
          }}
        >
          <CapacityHeatmap data={heatmapByWeek} />
          <StockoutPanel infeasibleProducts={infeasibleProducts} />
        </div>

        {/* ─── Raw-material risks (Phase 4m.1) ────────────── */}
        {(rawMaterialShortages.length > 0 || purchaseRequirements.length > 0) && (
          <div style={{ marginTop: 16 }}>
            <RawMaterialRiskPanel
              shortages={rawMaterialShortages}
              requirements={purchaseRequirements}
            />
          </div>
        )}
      </main>

      {/* ─── Right drawer ──────────────────────────────── */}
      {selected && (
        <ActivityDrawer
          // We always render the drawer against the LATEST data: look up the
          // original activity in `activities` (the server-rendered list) and
          // overlay any current mutation. Selected gets stale when mutations
          // happen otherwise.
          activity={selected}
          original={activitiesWithPo.find((a) => a.stableId === selected.stableId) ?? selected}
          routingRationale={routingDecisions[selected.productCode] ?? null}
          dismissed={isDismissed(mutations, selected.stableId)}
          rescheduledTo={rescheduledTo(mutations, selected.stableId)}
          editedQuantity={editedQuantityOf(mutations, selected.stableId)}
          editedLeadTimeDays={editedLeadTimeDaysOf(
            mutations,
            // Lead-time mutation is keyed on the place-by chip's stableId,
            // regardless of which sister chip the user clicked.
            selected.kind === 'po-receiving' && selected.poInfo
              ? selected.poInfo.sisterStableId
              : selected.stableId,
          )}
          vendor={vendorByCode[selected.productCode] ?? null}
          stationDailyMinutes={selected.station ? stationDailyMinutes[selected.station] ?? 480 : 480}
          kitchenChipMinutes={
            selected.kind === 'kitchen-required'
              ? kitchenMinutesByProductCode[selected.productCode] ?? KITCHEN_DEFAULT_CHIP_MINUTES
              : null
          }
          productOverride={productOverrides[selected.productCode]}
          stationDailyOutput={productStationDailyOutput[selected.productCode] ?? 0}
          globalShelfLifeDays={globalDefaults.shelfLifeDays}
          sohBreakdown={sohByProductCode[selected.productCode] ?? null}
          eligibleWarehouses={eligibleWarehouses}
          plannerInitialInventory={initialInventoryByProduct[selected.productCode] ?? 0}
          salesOrders={salesOrdersByProduct[selected.productCode] ?? []}
          totalCommitted={committedByProduct[selected.productCode] ?? 0}
          conflicts={conflictsByConsumer.get(selected.stableId) ?? []}
          onResolveConflicts={(strategy) => resolveAllConflicts(strategy)}
          onDismiss={() => dismiss(selected.stableId)}
          onUndismiss={() => undismiss(selected.stableId)}
          onReschedule={(date) => reschedule(selected.stableId, date)}
          onClearReschedule={() => clearReschedule(selected.stableId)}
          onEditQuantity={(qty) => editQuantity(selected.stableId, qty)}
          onClearEdit={() => clearEdit(selected.stableId)}
          onEditLeadTime={(days) => {
            const placeId =
              selected.kind === 'po-receiving' && selected.poInfo
                ? selected.poInfo.sisterStableId
                : selected.stableId;
            editLeadTime(placeId, days);
          }}
          onClearLeadTime={() => {
            const placeId =
              selected.kind === 'po-receiving' && selected.poInfo
                ? selected.poInfo.sisterStableId
                : selected.stableId;
            clearLeadTime(placeId);
          }}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h3
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: 'var(--text-muted)',
          marginBottom: 8,
          fontWeight: 500,
        }}
      >
        {title}
      </h3>
      {children}
    </div>
  );
}

/**
 * One row in the Reports section: report name on the left + Print and CSV
 * buttons on the right. Both buttons share the same enabled flag (a report
 * with zero activities still exports an empty CSV / "no items" page; we
 * just disable when there's literally nothing to say).
 */
function ReportRow({
  label,
  enabled,
  onPrint,
  onCsv,
}: {
  label: string;
  enabled: boolean;
  onPrint: () => void;
  onCsv: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        opacity: enabled ? 1 : 0.5,
      }}
    >
      <div style={{ flex: 1, fontSize: 12, fontWeight: 500 }}>{label}</div>
      <button
        type="button"
        onClick={onPrint}
        disabled={!enabled}
        title="Open a printable version in a new tab and trigger the print dialog."
        style={reportSubButtonStyle(enabled)}
      >
        Print
      </button>
      <button
        type="button"
        onClick={onCsv}
        disabled={!enabled}
        title="Download the report as a CSV file (opens in Excel / Sheets)."
        style={reportSubButtonStyle(enabled)}
      >
        CSV
      </button>
    </div>
  );
}

function reportSubButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    padding: '4px 8px',
    fontSize: 11,
    background: enabled ? 'var(--bg-page)' : 'transparent',
    color: enabled ? 'inherit' : 'var(--text-muted)',
    border: '0.5px solid var(--border)',
    borderRadius: 3,
    cursor: enabled ? 'pointer' : 'default',
    fontFamily: 'inherit',
    fontWeight: 500,
  };
}

function KPIRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'green' | 'amber' | 'red';
}) {
  const toneColor = tone === 'green' ? '#059669' : tone === 'amber' ? '#d97706' : tone === 'red' ? '#dc2626' : 'inherit';
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontWeight: 500, color: toneColor }}>{value}</span>
    </div>
  );
}

function MonthBlock({
  label,
  dates,
  activitiesByDate,
  peakLoadByDate,
  kitchenLoadByDate,
  onSelect,
  selectedId,
  mutations,
  conflictsByConsumer,
  unplaceableSet,
  hoveredStableId,
  onChipHover,
  relatedByStableId,
  onDropOnDate,
}: {
  label: string;
  dates: string[];
  activitiesByDate: Map<string, CalendarActivity[]>;
  peakLoadByDate: Map<string, { utilisation: number; usedMinutes: number; capacityMinutes: number; station: Station }>;
  /** Per-day kitchen-team utilisation (Phase 4l.7). */
  kitchenLoadByDate: Map<string, { usedMinutes: number; capacityMinutes: number; utilisation: number }>;
  onSelect: (a: CalendarActivity) => void;
  selectedId: string | null;
  mutations: MutationsMap;
  /** Map of stableId → conflicts (used to highlight chips with red borders). */
  conflictsByConsumer: Map<string, ScheduleConflict[]>;
  /** Set of stableIds left unplaced by the most-recent Resolve-all run. */
  unplaceableSet: ReadonlySet<string>;
  /** Currently-hovered chip stableId (drives the arrow overlay). */
  hoveredStableId: string | null;
  /** Hover handler — pass id on enter, null on leave. */
  onChipHover: (id: string | null) => void;
  /** stableId → list of related chips with direction. */
  relatedByStableId: ReadonlyMap<string, ReadonlyArray<{ stableId: string; kind: 'supplier' | 'consumer' }>>;
  /** Called when a chip is dropped onto a day cell. Skip same-day drops upstream. */
  onDropOnDate: (stableId: string, date: string) => void;
}) {
  // Local state: which day is currently drag-over, for visual highlighting.
  // Per-month — the user can only drag one thing at a time, so it's enough to
  // track inside this component without a ref.
  const [hoverDate, setHoverDate] = useState<string | null>(null);

  // Per-month chip ref registry — used by the arrow overlay to resolve DOM
  // positions. Refs live in a Map keyed by stableId; chips register on mount
  // and unregister on unmount via the callback-ref pattern.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chipRefs = useRef<Map<string, HTMLElement>>(new Map());
  const registerChipRef = useCallback((stableId: string, el: HTMLElement | null) => {
    if (el) chipRefs.current.set(stableId, el);
    else chipRefs.current.delete(stableId);
  }, []);

  // Computed arrows for the current hover. Coords are relative to containerRef.
  type Arrow = { id: string; x1: number; y1: number; x2: number; y2: number; kind: 'supplier' | 'consumer' };
  const [arrows, setArrows] = useState<Arrow[]>([]);
  // Re-measure on every layout pass while hover is active. Trigger when:
  //   - hoveredStableId changes (different chip hovered)
  //   - activitiesByDate changes (chips moved → DOM positions changed)
  //   - relatedByStableId changes (relationships updated)
  useLayoutEffect(() => {
    if (!hoveredStableId) {
      if (arrows.length > 0) setArrows([]);
      return;
    }
    const container = containerRef.current;
    const sourceEl = chipRefs.current.get(hoveredStableId);
    if (!container || !sourceEl) {
      // Hovered chip isn't in this month's grid → no arrows here.
      if (arrows.length > 0) setArrows([]);
      return;
    }
    const cRect = container.getBoundingClientRect();
    const sRect = sourceEl.getBoundingClientRect();
    const sCx = (sRect.left + sRect.right) / 2 - cRect.left;
    const sCy = (sRect.top + sRect.bottom) / 2 - cRect.top;
    const out: Arrow[] = [];
    for (const rel of relatedByStableId.get(hoveredStableId) ?? []) {
      const relEl = chipRefs.current.get(rel.stableId);
      if (!relEl) continue; // related chip not in this month
      const rRect = relEl.getBoundingClientRect();
      const rCx = (rRect.left + rRect.right) / 2 - cRect.left;
      const rCy = (rRect.top + rRect.bottom) / 2 - cRect.top;
      // Direction: arrow always flows supplier → consumer.
      // - rel.kind === 'supplier': rel is the supplier, source is the consumer.
      // - rel.kind === 'consumer': source is the supplier, rel is the consumer.
      if (rel.kind === 'supplier') {
        out.push({ id: rel.stableId, x1: rCx, y1: rCy, x2: sCx, y2: sCy, kind: 'supplier' });
      } else {
        out.push({ id: rel.stableId, x1: sCx, y1: sCy, x2: rCx, y2: rCy, kind: 'consumer' });
      }
    }
    setArrows(out);
    // We intentionally exclude `arrows` from deps to avoid re-running on our own setState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoveredStableId, activitiesByDate, relatedByStableId]);

  // Set of stableIds currently related to the hovered chip — used to highlight
  // related chips with a colored ring. Computed cheaply once per render.
  const relatedHighlight = useMemo(() => {
    const out = new Map<string, 'supplier' | 'consumer'>();
    if (!hoveredStableId) return out;
    for (const rel of relatedByStableId.get(hoveredStableId) ?? []) {
      out.set(rel.stableId, rel.kind);
    }
    return out;
  }, [hoveredStableId, relatedByStableId]);

  // Pad the front of the first week so calendar columns align with day-of-week.
  const first = fromISO(dates[0]);
  const dowOfFirst = (first.getDay() + 6) % 7; // Mon = 0
  const padCount = dowOfFirst;
  const cells: ({ date: string } | { pad: true })[] = [];
  for (let i = 0; i < padCount; i++) cells.push({ pad: true });
  for (const d of dates) cells.push({ date: d });

  return (
    <div style={{ marginBottom: 32 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>{label}</h2>
      <div
        ref={containerRef}
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          border: '0.5px solid var(--border)',
          borderRadius: 6,
          overflow: 'hidden',
          background: 'var(--bg-surface)',
          position: 'relative',
        }}
      >
        {DAY_NAMES.map((n) => (
          <div
            key={n}
            style={{
              padding: '6px 8px',
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--text-muted)',
              borderBottom: '0.5px solid var(--border)',
              fontWeight: 500,
            }}
          >
            {n}
          </div>
        ))}
        {cells.map((cell, idx) => {
          if ('pad' in cell) {
            return (
              <div
                key={`pad-${idx}`}
                style={{ minHeight: 110, background: 'var(--bg-page)', borderRight: '0.5px solid var(--border)', borderBottom: '0.5px solid var(--border)' }}
              />
            );
          }
          const dayActivities = activitiesByDate.get(cell.date) ?? [];
          const dow = (fromISO(cell.date).getDay() + 6) % 7;
          const isWeekend = dow >= 5;
          const peakLoad = peakLoadByDate.get(cell.date);
          const kitchenLoad = kitchenLoadByDate.get(cell.date);
          const overrun = peakLoad ? peakLoad.utilisation > 1 : false;
          const kitchenOverrun = kitchenLoad ? kitchenLoad.utilisation > 1 : false;
          const isHover = hoverDate === cell.date;
          // We need a deterministic cellKey so the drop-state computation
          // closes over the right date. Captured below.
          const dropDate = cell.date;
          return (
            <div
              key={cell.date}
              onDragOver={(e) => {
                // preventDefault is what makes the cell a valid drop target;
                // without it the browser rejects the drop with cursor=no-drop.
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (hoverDate !== dropDate) setHoverDate(dropDate);
              }}
              onDragLeave={() => {
                if (hoverDate === dropDate) setHoverDate(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setHoverDate(null);
                const stableId = e.dataTransfer.getData('text/plain');
                if (stableId) onDropOnDate(stableId, dropDate);
              }}
              style={{
                minHeight: 110,
                padding: 4,
                borderRight: '0.5px solid var(--border)',
                borderBottom: '0.5px solid var(--border)',
                background: isHover
                  ? '#eff6ff'
                  : isWeekend
                  ? 'var(--bg-page)'
                  : 'transparent',
                opacity: isWeekend && !isHover ? 0.5 : 1,
                position: 'relative',
                outline: isHover
                  ? '1.5px dashed #3b82f6'
                  : overrun
                  ? '1.5px solid #dc2626'
                  : 'none',
                outlineOffset: -1,
                transition: 'background 80ms ease',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  marginBottom: 4,
                }}
              >
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {fmtDayShort(cell.date)}
                </span>
                <div style={{ display: 'flex', gap: 4, alignItems: 'baseline' }}>
                  {kitchenLoad && (
                    <span
                      style={{
                        fontSize: 9,
                        color: kitchenOverrun
                          ? '#dc2626'
                          : kitchenLoad.utilisation > 0.85
                          ? '#d97706'
                          : 'var(--text-muted)',
                        fontWeight: kitchenOverrun ? 600 : 400,
                      }}
                      title={`Kitchen team: ${Math.round(kitchenLoad.usedMinutes)}/${kitchenLoad.capacityMinutes} min (${Math.round(kitchenLoad.utilisation * 100)}%)`}
                    >
                      K{Math.round(kitchenLoad.utilisation * 100)}%
                    </span>
                  )}
                  {peakLoad && (
                    <span
                      style={{
                        fontSize: 9,
                        color: overrun ? '#dc2626' : peakLoad.utilisation > 0.85 ? '#d97706' : 'var(--text-muted)',
                        fontWeight: overrun ? 600 : 400,
                      }}
                      title={`Peak load: ${peakLoad.station} at ${peakLoad.usedMinutes}/${peakLoad.capacityMinutes} min`}
                    >
                      {Math.round(peakLoad.utilisation * 100)}%
                    </span>
                  )}
                </div>
              </div>
              {dayActivities.map((a) => (
                <ActivityChip
                  key={a.id}
                  activity={a}
                  selected={a.id === selectedId}
                  dismissed={isDismissed(mutations, a.stableId)}
                  conflicted={conflictsByConsumer.has(a.stableId)}
                  unplaceable={unplaceableSet.has(a.stableId)}
                  relatedKind={relatedHighlight.get(a.stableId) ?? null}
                  isHoveredSource={hoveredStableId === a.stableId}
                  registerRef={registerChipRef}
                  onHover={onChipHover}
                  onClick={() => onSelect(a)}
                />
              ))}
              {(peakLoad || kitchenLoad) && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: 0,
                    left: 0,
                    right: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 1,
                  }}
                >
                  {/* Kitchen-team sub-bar (Phase 4l.7). Positioned ABOVE
                      the packaging bar so packaging stays the canonical
                      "bottom strip" the user is used to. Italic K marker
                      in the corner makes the bar's identity obvious without
                      a legend. */}
                  {kitchenLoad && (
                    <div
                      style={{
                        height: 2,
                        background: 'var(--border)',
                      }}
                    >
                      <div
                        style={{
                          width: `${Math.min(100, kitchenLoad.utilisation * 100)}%`,
                          height: '100%',
                          background: kitchenOverrun
                            ? '#dc2626'
                            : kitchenLoad.utilisation > 0.85
                            ? '#d97706'
                            : '#a78bfa',
                        }}
                      />
                    </div>
                  )}
                  {peakLoad && (
                    <div
                      style={{
                        height: 3,
                        background: 'var(--border)',
                      }}
                    >
                      <div
                        style={{
                          width: `${Math.min(100, peakLoad.utilisation * 100)}%`,
                          height: '100%',
                          background: overrun
                            ? '#dc2626'
                            : peakLoad.utilisation > 0.85
                            ? '#d97706'
                            : '#10b981',
                        }}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* ─── Hover-arrow overlay (Phase 4l.5) ─────────────────
            Absolutely positioned over the month grid; pointer-events:none
            so day cells/chips remain interactive. Drawn only while a chip
            in this month is hovered AND has visible related chips. */}
        {arrows.length > 0 && (
          <svg
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              pointerEvents: 'none',
              overflow: 'visible',
            }}
            aria-hidden="true"
          >
            <defs>
              <marker
                id={`arrow-supplier-${label}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#059669" />
              </marker>
              <marker
                id={`arrow-consumer-${label}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#d97706" />
              </marker>
            </defs>
            {arrows.map((a) => (
              <line
                key={a.id + a.kind}
                x1={a.x1}
                y1={a.y1}
                x2={a.x2}
                y2={a.y2}
                stroke={a.kind === 'supplier' ? '#059669' : '#d97706'}
                strokeWidth={1.5}
                strokeOpacity={0.8}
                strokeDasharray="4 3"
                markerEnd={`url(#arrow-${a.kind}-${label})`}
              />
            ))}
          </svg>
        )}
      </div>
    </div>
  );
}

function ActivityChip({
  activity,
  selected,
  dismissed,
  conflicted,
  unplaceable,
  relatedKind,
  isHoveredSource,
  registerRef,
  onHover,
  onClick,
}: {
  activity: CalendarActivity;
  selected: boolean;
  dismissed: boolean;
  conflicted: boolean;
  unplaceable: boolean;
  /** Highlight as supplier/consumer of the currently-hovered chip, or null. */
  relatedKind: 'supplier' | 'consumer' | null;
  /** True when THIS chip is the one being hovered. Drives the source-glow style. */
  isHoveredSource: boolean;
  /** Callback-ref hook so MonthBlock can resolve this chip's DOM position. */
  registerRef: (stableId: string, el: HTMLElement | null) => void;
  /** Hover handler — id on enter, null on leave. */
  onHover: (id: string | null) => void;
  onClick: () => void;
}) {
  const colors = colorOf(activity);
  // Local "is dragging" state controls opacity feedback. Reset on dragend.
  const [isDragging, setIsDragging] = useState(false);
  // PO chips have derived dates (computed from kitchen demand + lead time)
  // and aren't draggable — moving them would mislead the user about what
  // actually changes the timeline.
  const isPo = activity.kind === 'po-placed' || activity.kind === 'po-receiving';
  // Compose the box-shadow: conflict (red) + related (green/orange) +
  // hovered-source (blue) can stack.
  const shadows: string[] = [];
  if (conflicted) shadows.push('inset 0 0 0 1.5px #dc2626');
  if (relatedKind === 'supplier') shadows.push('inset 0 0 0 1.5px #059669');
  if (relatedKind === 'consumer') shadows.push('inset 0 0 0 1.5px #d97706');
  if (isHoveredSource) shadows.push('0 0 0 2px #3b82f6');
  if (unplaceable) shadows.push('inset 0 0 0 1.5px #d97706');
  return (
    <button
      type="button"
      onClick={onClick}
      ref={(el) => registerRef(activity.stableId, el)}
      onMouseEnter={() => onHover(activity.stableId)}
      onMouseLeave={() => onHover(null)}
      // Dragging the chip writes its stableId to the dataTransfer; day cells
      // read that to apply a reschedule mutation. PO chips opt out — their
      // dates are derived, not authoritative.
      draggable={!isPo}
      onDragStart={(e) => {
        if (isPo) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.setData('text/plain', activity.stableId);
        e.dataTransfer.effectAllowed = 'move';
        setIsDragging(true);
        // Drop hover on drag-start: the user is no longer pointing at it.
        onHover(null);
      }}
      onDragEnd={() => setIsDragging(false)}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '2px 6px',
        margin: '1px 0',
        fontSize: 11,
        background: colors.bg,
        color: colors.text,
        borderRadius: 3,
        border: 'none',
        borderLeft: `3px solid ${colors.border}`,
        outline: selected ? `1.5px solid ${colors.border}` : 'none',
        cursor: isPo ? 'pointer' : isDragging ? 'grabbing' : 'grab',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        opacity: isDragging ? 0.4 : dismissed ? 0.35 : 1,
        textDecoration: dismissed ? 'line-through' : 'none',
        boxShadow: shadows.length > 0 ? shadows.join(', ') : undefined,
        position: 'relative',
        zIndex: isHoveredSource ? 2 : 'auto',
      }}
      title={
        activity.kind === 'po-placed'
          ? `PLACE PO · ${activity.productCode} — ${activity.productName}\nQty ${Math.round(activity.quantity).toLocaleString()}\nPlace by ${activity.poInfo ? fmtDate(activity.poInfo.placeByDate) : '?'}, arrives ${activity.poInfo ? fmtDate(activity.poInfo.arriveByDate) : '?'} (${activity.poInfo?.leadTimeDays}-day lead time)${activity.poInfo?.overdue ? '\n⚠ OVERDUE — placeBy is in the past' : ''}`
          : activity.kind === 'po-receiving'
          ? `RECEIVE PO · ${activity.productCode} — ${activity.productName}\nQty ${Math.round(activity.quantity).toLocaleString()}\nArrive by ${activity.poInfo ? fmtDate(activity.poInfo.arriveByDate) : '?'}, place by ${activity.poInfo ? fmtDate(activity.poInfo.placeByDate) : '?'} (${activity.poInfo?.leadTimeDays}-day lead time)${activity.poInfo?.overdue ? '\n⚠ Linked PO is OVERDUE' : ''}`
          : activity.kind === 'kitchen-required'
          ? `${activity.productCode} — ${activity.productName} — REQUIRED ${activity.quantity} units · starts ${fmtDate(activity.date)}, finishes ${activity.finishDate ? fmtDate(activity.finishDate) : '?'}, available ${activity.requiredByDate ? fmtDate(activity.requiredByDate) : '?'}`
          : dismissed
          ? `${activity.productCode} — ${activity.productName} — DISMISSED (${activity.quantity} units, ${Math.round(activity.durationMinutes)} min)`
          : unplaceable
          ? `${activity.productCode} — ${activity.productName} — Resolve all couldn't find a feasible date for this chip (no working day with capacity within search horizon)`
          : `${activity.productCode} — ${activity.productName} (${activity.quantity} units, ${Math.round(activity.durationMinutes)} min)`
      }
    >
      <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {conflicted && <span style={{ marginRight: 3 }}>⚠</span>}
        {unplaceable && !conflicted && <span style={{ marginRight: 3 }}>⚠</span>}
        {activity.kind === 'po-placed' && (
          <span style={{ marginRight: 3, fontWeight: 600 }}>
            {activity.poInfo?.overdue ? '⚠ ' : ''}PO→
          </span>
        )}
        {activity.kind === 'po-receiving' && (
          <span style={{ marginRight: 3, fontWeight: 600 }}>
            {activity.poInfo?.overdue ? '⚠ ' : ''}↓PO
          </span>
        )}
        {activity.productCode} <span style={{ opacity: 0.7 }}>×{Math.round(activity.quantity)}</span>
        {activity.kind === 'kitchen-required' && activity.durationDays && activity.durationDays > 1 && (
          <span style={{ opacity: 0.7 }}> · {activity.durationDays}d</span>
        )}
      </div>
      {activity.productName && activity.productName !== activity.productCode && (
        <div
          style={{
            fontSize: 9,
            opacity: 0.65,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            marginTop: 1,
            lineHeight: 1.2,
          }}
        >
          {activity.productName}
        </div>
      )}
    </button>
  );
}

function ActivityDrawer({
  activity,
  original,
  routingRationale,
  dismissed,
  rescheduledTo: rescheduled,
  editedQuantity,
  editedLeadTimeDays,
  vendor,
  stationDailyMinutes,
  kitchenChipMinutes,
  productOverride,
  stationDailyOutput,
  globalShelfLifeDays,
  sohBreakdown,
  eligibleWarehouses,
  plannerInitialInventory,
  salesOrders,
  totalCommitted,
  conflicts,
  onResolveConflicts,
  onDismiss,
  onUndismiss,
  onReschedule,
  onClearReschedule,
  onEditQuantity,
  onClearEdit,
  onEditLeadTime,
  onClearLeadTime,
  onClose,
}: {
  activity: CalendarActivity;
  /** The unmutated activity from the server output — used to display "original" values. */
  original: CalendarActivity;
  routingRationale: string | null;
  dismissed: boolean;
  rescheduledTo: string | null;
  editedQuantity: number | null;
  /** Lead-time override on a PO chip (Phase 4m.4). null = use file default. */
  editedLeadTimeDays: number | null;
  /** Vendor name from the lead-times file, or null when missing. */
  vendor: string | null;
  stationDailyMinutes: number;
  /**
   * Per-recipe kitchen-team minutes consumed on the START day. `null` for
   * non-kitchen-required activities (Phase 4l.8).
   */
  kitchenChipMinutes: number | null;
  productOverride: ProductOverrideShape | undefined;
  stationDailyOutput: number;
  globalShelfLifeDays: number;
  /** Per-warehouse SOH breakdown for this product, or null when cache is empty. */
  sohBreakdown: Record<string, number> | null;
  /** Warehouses whose stock is summed into initialInventory (others displayed muted). */
  eligibleWarehouses: string[];
  /** What the planner used as initialInventory for this product. */
  plannerInitialInventory: number;
  /** Active sales-order lines for this product (sorted ascending by date). */
  salesOrders: Array<{
    orderNumber: string;
    customerName: string;
    orderStatus: string;
    requiredDate: string;
    quantityRemaining: number;
  }>;
  totalCommitted: number;
  conflicts: ScheduleConflict[];
  /** Auto-cascade resolver — push (consumers later) or pull (suppliers earlier). */
  onResolveConflicts: (strategy: ResolveStrategy) => void;
  onDismiss: () => void;
  onUndismiss: () => void;
  onReschedule: (newDate: string) => void;
  onClearReschedule: () => void;
  onEditQuantity: (qty: number) => void;
  onClearEdit: () => void;
  /** Apply a lead-time override (PO chips). */
  onEditLeadTime: (days: number) => void;
  onClearLeadTime: () => void;
  onClose: () => void;
}) {
  const colors = colorOf(activity);

  // Edit-quantity input local state — only commits to the mutation store on Apply.
  const [qtyInput, setQtyInput] = useState<string>('');
  useEffect(() => {
    setQtyInput(String(activity.quantity));
  }, [activity.quantity, activity.stableId]);

  const parsedQty = Number(qtyInput);
  const qtyValid = Number.isFinite(parsedQty) && parsedQty > 0;
  const qtyChanged = qtyValid && Math.round(parsedQty) !== Math.round(activity.quantity);

  // Warn if the edited batch would exceed station daily capacity in minutes.
  // Conservative: scale duration proportionally from current.
  const wouldOversize =
    qtyValid &&
    activity.quantity > 0 &&
    (activity.durationMinutes * (parsedQty / activity.quantity)) > stationDailyMinutes;

  // ─── PO chip lead-time editor state (Phase 4m.4) ──────────
  const isPo = activity.kind === 'po-placed' || activity.kind === 'po-receiving';
  const effectiveLeadTime =
    activity.poInfo
      ? editedLeadTimeDays ?? activity.poInfo.leadTimeDays
      : 0;
  const [leadInput, setLeadInput] = useState<string>('');
  useEffect(() => {
    if (isPo) setLeadInput(String(effectiveLeadTime));
  }, [activity.stableId, effectiveLeadTime, isPo]);
  const parsedLead = Number(leadInput);
  const leadValid = Number.isFinite(parsedLead) && parsedLead >= 0;
  const leadChanged = leadValid && Math.round(parsedLead) !== effectiveLeadTime;
  return (
    <aside
      style={{
        width: 320,
        padding: 20,
        borderLeft: '0.5px solid var(--border)',
        background: 'var(--bg-surface)',
        flexShrink: 0,
        position: 'sticky',
        top: 60, // matches the left rail's sticky offset
        maxHeight: 'calc(100vh - 60px)',
        overflowY: 'auto',
        alignSelf: 'flex-start',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600 }}>Activity</h3>
        <button
          type="button"
          onClick={onClose}
          style={{
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: 'var(--text-muted)',
            fontSize: 16,
            padding: 4,
          }}
          aria-label="Close drawer"
        >
          ×
        </button>
      </div>

      <div
        style={{
          display: 'inline-block',
          padding: '2px 8px',
          fontSize: 11,
          background: colors.bg,
          color: colors.text,
          borderRadius: 3,
          marginBottom: 12,
          textTransform: 'capitalize',
        }}
      >
        {activity.kind === 'kitchen'
          ? `Kitchen (scheduled)${activity.assemblyNumber ? ` · ${activity.assemblyNumber}` : ''}`
          : activity.kind === 'kitchen-required'
          ? 'Kitchen (required by plan)'
          : activity.kind === 'po-placed'
          ? 'Purchase order — place by'
          : activity.kind === 'po-receiving'
          ? 'Purchase order — arrive by'
          : activity.station
          ? STATION_LABELS[activity.station]
          : '—'}
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Product
        </div>
        <div style={{ fontWeight: 500, fontSize: 14, marginTop: 2 }}>{activity.productName}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
          {activity.productCode}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13, marginBottom: 16 }}>
        <Field
          label={activity.kind === 'kitchen-required' ? 'Start' : 'Date'}
          value={fmtDate(activity.date)}
          modified={rescheduled !== null}
          originalValue={rescheduled ? fmtDate(original.date) : undefined}
        />
        <Field
          label="Quantity"
          value={`${Math.round(activity.quantity)}`}
          modified={editedQuantity !== null}
          originalValue={editedQuantity !== null ? `${Math.round(original.quantity)}` : undefined}
        />
        {activity.kind === 'kitchen-required' && activity.finishDate && (
          <>
            <Field label="Finish" value={fmtDate(activity.finishDate)} />
            <Field label="Duration" value={`${activity.durationDays ?? 1} days`} />
          </>
        )}
        {activity.kind === 'kitchen-required' && activity.requiredByDate && (
          <Field
            label="Available for use"
            value={fmtDate(activity.requiredByDate)}
          />
        )}
        {activity.kind === 'kitchen-required' && kitchenChipMinutes !== null && (
          <Field
            label="Kitchen-team min"
            value={`${kitchenChipMinutes} min on start day`}
          />
        )}
        {/* Purchase order details (Phase 4m.2 + 4m.4). Shows the EFFECTIVE
            dates (computed with any lead-time override) plus the ideal
            file-default values for context. */}
        {(activity.kind === 'po-placed' || activity.kind === 'po-receiving') &&
          activity.poInfo && (
            <>
              <Field
                label="Place by"
                value={fmtDate(activity.date)}
                modified={activity.poInfo.overdue}
                originalValue={
                  activity.poInfo.overdue
                    ? fmtDate(activity.poInfo.placeByDate)
                    : undefined
                }
              />
              <Field
                label="Arrive by"
                value={
                  activity.kind === 'po-receiving'
                    ? fmtDate(activity.date)
                    : fmtDate(
                        // Compute effective arrival from poInfo + this chip's date.
                        addDaysIso(activity.date, effectiveLeadTime),
                      )
                }
                modified={editedLeadTimeDays !== null || activity.poInfo.overdue}
                originalValue={
                  editedLeadTimeDays !== null || activity.poInfo.overdue
                    ? fmtDate(activity.poInfo.arriveByDate)
                    : undefined
                }
              />
              <Field
                label="Lead time"
                value={`${effectiveLeadTime} days`}
                modified={editedLeadTimeDays !== null}
                originalValue={
                  editedLeadTimeDays !== null
                    ? `${activity.poInfo.leadTimeDays} days (default)`
                    : undefined
                }
              />
              <Field
                label="Status"
                value={activity.poInfo.overdue ? 'OVERDUE' : 'On track'}
              />
              {vendor && <Field label="Vendor" value={vendor} />}
            </>
          )}
        {activity.kind === 'packaging' && (
          <>
            <Field label="Production" value={`${Math.round(activity.durationMinutes)} min`} />
            <Field
              label="Changeover"
              value={`${Math.round(activity.changeoverMinutes)} min`}
            />
          </>
        )}
        <Field label="Family" value={activity.family ?? '—'} />
        <Field label="Extended family" value={activity.extendedFamily ?? '—'} />
      </div>

      {/* ─── Stock on hand (per-warehouse) ─────────────── */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
          Stock on hand
        </div>
        {sohBreakdown === null ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            No SOH cache. Click Refresh SOH in the header.
          </div>
        ) : Object.keys(sohBreakdown).length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            No stock recorded for this product.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 12 }}>
            {Object.entries(sohBreakdown)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([wh, qty]) => {
                const isEligible = eligibleWarehouses.includes(wh);
                return (
                  <li
                    key={wh}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      padding: '2px 0',
                      color: isEligible ? 'var(--text-primary)' : 'var(--text-muted)',
                      opacity: isEligible ? 1 : 0.7,
                    }}
                  >
                    <span>
                      {wh}
                      {!isEligible && (
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                          {' · excluded'}
                        </span>
                      )}
                    </span>
                    <span>{qty.toLocaleString()}</span>
                  </li>
                );
              })}
          </ul>
        )}
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
          Planner used: {plannerInitialInventory.toLocaleString()} units (sum of eligible warehouses)
        </div>
      </div>

      {/* ─── Reschedule (any date) ────────────────────── */}
      <div style={{ marginBottom: 14 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            fontSize: 11,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginBottom: 6,
          }}
        >
          <span>Reschedule</span>
          {original.date !== activity.date && (
            <span
              style={{
                textTransform: 'none',
                letterSpacing: 0,
                fontSize: 10,
                color: 'var(--text-muted)',
              }}
            >
              original: {original.date}
            </span>
          )}
        </div>
        <input
          type="date"
          value={activity.date}
          onChange={(e) => {
            const v = e.target.value;
            if (v && v !== activity.date) onReschedule(v);
          }}
          style={{
            width: '100%',
            padding: '6px 8px',
            fontSize: 13,
            border: '0.5px solid var(--border)',
            borderRadius: 3,
            background: 'var(--bg-page)',
            color: 'inherit',
            fontFamily: 'inherit',
          }}
        />
        <div
          style={{
            marginTop: 6,
            fontSize: 10,
            color: 'var(--text-muted)',
          }}
        >
          Tip: drag the chip to a day on the calendar to reschedule visually.
        </div>
        {rescheduled && (
          <button
            type="button"
            onClick={onClearReschedule}
            style={{
              marginTop: 6,
              fontSize: 11,
              color: 'var(--text-muted)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              fontFamily: 'inherit',
              textDecoration: 'underline',
            }}
          >
            Reset to original day
          </button>
        )}
      </div>

      {/* ─── Edit quantity ─────────────────────────────── */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
          Edit quantity
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="number"
            min={1}
            value={qtyInput}
            onChange={(e) => setQtyInput(e.target.value)}
            style={{
              flex: 1,
              padding: '6px 8px',
              fontSize: 13,
              border: '0.5px solid var(--border)',
              borderRadius: 3,
              fontFamily: 'inherit',
              background: 'var(--bg-page)',
              color: 'inherit',
            }}
          />
          <button
            type="button"
            onClick={() => qtyValid && onEditQuantity(parsedQty)}
            disabled={!qtyValid || !qtyChanged}
            style={{
              padding: '6px 12px',
              fontSize: 12,
              border: '0.5px solid var(--border)',
              borderRadius: 3,
              background: qtyValid && qtyChanged ? colors.bg : 'var(--bg-page)',
              color: qtyValid && qtyChanged ? colors.text : 'var(--text-muted)',
              cursor: qtyValid && qtyChanged ? 'pointer' : 'default',
              fontFamily: 'inherit',
            }}
          >
            Apply
          </button>
        </div>
        {wouldOversize && qtyChanged && (
          <div style={{ marginTop: 6, fontSize: 11, color: '#d97706' }}>
            ⚠ This quantity would exceed the station's daily capacity ({stationDailyMinutes} min).
          </div>
        )}
        {editedQuantity !== null && (
          <button
            type="button"
            onClick={onClearEdit}
            style={{
              marginTop: 6,
              fontSize: 11,
              color: 'var(--text-muted)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              fontFamily: 'inherit',
              textDecoration: 'underline',
            }}
          >
            Reset to original quantity
          </button>
        )}
      </div>

      {/* ─── Edit lead time (Phase 4m.4) ──────────────────
          Only on PO chips. Shifts both place-by and arrive-by chips by
          the difference between the override and the file default.
          Useful for transient shipping delays the user knows about. */}
      {isPo && activity.poInfo && (
        <div style={{ marginBottom: 14 }}>
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 6,
            }}
          >
            Edit lead time
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="number"
              min={0}
              value={leadInput}
              onChange={(e) => setLeadInput(e.target.value)}
              style={{
                flex: 1,
                padding: '6px 8px',
                fontSize: 13,
                border: '0.5px solid var(--border)',
                borderRadius: 3,
                fontFamily: 'inherit',
                background: 'var(--bg-page)',
                color: 'inherit',
              }}
            />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>days</span>
            <button
              type="button"
              onClick={() => leadValid && onEditLeadTime(parsedLead)}
              disabled={!leadValid || !leadChanged}
              style={{
                padding: '6px 12px',
                fontSize: 12,
                border: '0.5px solid var(--border)',
                borderRadius: 3,
                background:
                  leadValid && leadChanged ? colors.bg : 'var(--bg-page)',
                color:
                  leadValid && leadChanged ? colors.text : 'var(--text-muted)',
                cursor: leadValid && leadChanged ? 'pointer' : 'default',
                fontFamily: 'inherit',
              }}
            >
              Apply
            </button>
          </div>
          <div
            style={{
              marginTop: 6,
              fontSize: 10,
              color: 'var(--text-muted)',
              lineHeight: 1.4,
            }}
          >
            File default: {activity.poInfo.leadTimeDays} days. Override applies
            to this PO only and is stored in your browser; clear it to re-use
            the default.
          </div>
          {editedLeadTimeDays !== null && (
            <button
              type="button"
              onClick={onClearLeadTime}
              style={{
                marginTop: 6,
                fontSize: 11,
                color: 'var(--text-muted)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                fontFamily: 'inherit',
                textDecoration: 'underline',
              }}
            >
              Reset to file default
            </button>
          )}
        </div>
      )}

      {routingRationale && (
        <div
          style={{
            padding: 10,
            background: '#eff6ff',
            border: '0.5px solid #bfdbfe',
            borderRadius: 4,
            fontSize: 11,
            color: '#1e3a8a',
            marginBottom: 12,
          }}
        >
          <div style={{ fontWeight: 500, marginBottom: 2 }}>Why this station?</div>
          {routingRationale}
        </div>
      )}

      {/* ─── Schedule conflicts (Phase 4l.2) ──────────── */}
      {conflicts.length > 0 && (
        <div
          style={{
            marginBottom: 14,
            padding: 10,
            background: '#fef2f2',
            border: '0.5px solid #fecaca',
            borderRadius: 4,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 6,
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: '#991b1b',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                fontWeight: 500,
                flex: 1,
              }}
            >
              ⚠ Schedule conflicts ({conflicts.length})
            </div>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <button
                type="button"
                onClick={() => onResolveConflicts('auto')}
                title="Try to pull the blocking run earlier; if it can't be pulled (floored or kitchen capacity), push this activity later instead."
                style={{
                  padding: '4px 10px',
                  fontSize: 10,
                  background: '#dc2626',
                  color: '#fff',
                  border: '0.5px solid #b91c1c',
                  borderRadius: 3,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                }}
              >
                Resolve (auto)
              </button>
              <button
                type="button"
                onClick={() => onResolveConflicts('pull')}
                title="Pull the blocking ingredient run earlier so it finishes in time. Floored at the planning-horizon start and respects kitchen-team capacity."
                style={{
                  padding: '3px 6px',
                  fontSize: 9,
                  background: '#fee2e2',
                  color: '#991b1b',
                  border: '0.5px solid #fecaca',
                  borderRadius: 3,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                }}
              >
                ←
              </button>
              <button
                type="button"
                onClick={() => onResolveConflicts('push')}
                title="Push this activity later to the earliest feasible date and recompute."
                style={{
                  padding: '3px 6px',
                  fontSize: 9,
                  background: '#fee2e2',
                  color: '#991b1b',
                  border: '0.5px solid #fecaca',
                  borderRadius: 3,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                }}
              >
                →
              </button>
            </div>
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 11 }}>
            {conflicts.map((c, i) => (
              <li
                key={i}
                style={{
                  padding: '4px 0',
                  color: '#991b1b',
                  borderBottom: i < conflicts.length - 1 ? '0.5px solid #fecaca' : 'none',
                }}
              >
                Needs <strong>{c.ingredientCode}</strong> ready by{' '}
                <strong>{fmtDate(c.consumerDate)}</strong>; closest run finishes{' '}
                <strong>{fmtDate(c.earliestFinishDate)}</strong>.
              </li>
            ))}
          </ul>
          <div style={{ fontSize: 10, color: '#7f1d1d', marginTop: 6 }}>
            Move this chip later, or move the upstream chip to finish sooner. The 1-day buffer must hold.
            Resolve auto-cascades through dependents.
          </div>
        </div>
      )}

      {/* ─── Committed customer orders (Phase 4h.3) ─────── */}
      {(salesOrders.length > 0 || totalCommitted > 0) && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
            <span>Committed orders</span>
            <span>total {totalCommitted.toLocaleString()} units</span>
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 11, maxHeight: 140, overflowY: 'auto' }}>
            {salesOrders.map((so) => {
              const statusColor =
                so.orderStatus === 'Backordered' ? '#dc2626'
                : so.orderStatus === 'Placed' ? '#1e40af'
                : 'var(--text-muted)';
              return (
                <li
                  key={so.orderNumber}
                  style={{
                    padding: '3px 0',
                    borderBottom: '0.5px solid var(--border)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontWeight: 500 }}>{so.orderNumber}</span>
                    <span>{so.quantityRemaining.toLocaleString()} units</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)' }}>
                    <span title={so.customerName} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>
                      {so.customerName}
                    </span>
                    <span style={{ display: 'flex', gap: 6 }}>
                      <span style={{ color: statusColor }}>{so.orderStatus}</span>
                      <span>by {fmtDate(so.requiredDate)}</span>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* ─── Per-product overrides (Phase 4f) ──────────── */}
      <ProductOverrideSection
        productCode={activity.productCode}
        override={productOverride}
        stationDailyOutput={stationDailyOutput}
        globalShelfLifeDays={globalShelfLifeDays}
      />

      {/* Action buttons. */}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        {dismissed ? (
          <button
            type="button"
            onClick={onUndismiss}
            style={{
              flex: 1,
              padding: '8px 12px',
              fontSize: 13,
              border: '0.5px solid var(--border)',
              borderRadius: 4,
              background: 'var(--bg-page)',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Restore
          </button>
        ) : (
          <button
            type="button"
            onClick={onDismiss}
            style={{
              flex: 1,
              padding: '8px 12px',
              fontSize: 13,
              border: '0.5px solid #fecaca',
              borderRadius: 4,
              background: '#fef2f2',
              color: '#991b1b',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Dismiss
          </button>
        )}
      </div>

      {dismissed && (
        <div
          style={{
            marginTop: 12,
            padding: 8,
            background: '#fef2f2',
            border: '0.5px solid #fecaca',
            borderRadius: 4,
            fontSize: 11,
            color: '#991b1b',
          }}
        >
          Dismissed — won't count toward day load. Click Restore to re-include.
        </div>
      )}

    </aside>
  );
}

// ─── Per-product override editor (Phase 4f) ─────────────────

function ProductOverrideSection({
  productCode,
  override,
  stationDailyOutput,
  globalShelfLifeDays,
}: {
  productCode: string;
  override: ProductOverrideShape | undefined;
  stationDailyOutput: number;
  globalShelfLifeDays: number;
}) {
  // Local form state — committed only when the user clicks Save.
  // Reset the form when the productCode changes (different SKU selected).
  const [shelfLifeInput, setShelfLifeInput] = useState<string>('');
  const [maxBatchInput, setMaxBatchInput] = useState<string>('');
  const [saving, setSaving] = useState<'shelfLife' | 'maxBatch' | null>(null);
  const [saved, setSaved] = useState<'shelfLife' | 'maxBatch' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setShelfLifeInput(
      override?.shelfLifeDays !== undefined ? String(override.shelfLifeDays) : '',
    );
    setMaxBatchInput(
      override?.maxBatchSize !== undefined ? String(override.maxBatchSize) : '',
    );
    setSaved(null);
    setError(null);
  }, [productCode, override]);

  async function postOverride(field: 'shelfLifeDays' | 'maxBatchSize', value: number | null) {
    setSaving(field === 'shelfLifeDays' ? 'shelfLife' : 'maxBatch');
    setError(null);
    try {
      // Empty value = clear via DELETE (only when it's the only override).
      // For partial clear we POST with the field omitted; the server merges
      // the override map. Since our API merges, posting only the OTHER
      // field doesn't clear this one — so we need a different mechanism.
      // For now, post a fresh override and rely on cleanOverride to drop
      // the missing field. But that's a merge — old value persists.
      // Simplest robust approach: for "clear single field", send a special
      // request that overwrites with the remaining fields only.
      // For MVP we just save what's in the form; explicit "clear" buttons
      // call DELETE for the whole product.
      const body = { productCode, override: { [field]: value } };
      const res = await fetch('/api/product-overrides', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSaved(field === 'shelfLifeDays' ? 'shelfLife' : 'maxBatch');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(null);
    }
  }

  async function clearAllOverrides() {
    setSaving('shelfLife');
    setError(null);
    try {
      const res = await fetch(
        `/api/product-overrides?productCode=${encodeURIComponent(productCode)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setShelfLifeInput('');
      setMaxBatchInput('');
      setSaved('shelfLife');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Clear failed');
    } finally {
      setSaving(null);
    }
  }

  const shelfLifeValue = Number(shelfLifeInput);
  const shelfLifeValid = !shelfLifeInput || (Number.isFinite(shelfLifeValue) && shelfLifeValue > 0);
  const shelfLifeChanged =
    shelfLifeValid &&
    shelfLifeInput !== '' &&
    Math.round(shelfLifeValue) !== (override?.shelfLifeDays ?? -1);
  const maxBatchValue = Number(maxBatchInput);
  const maxBatchValid = !maxBatchInput || (Number.isFinite(maxBatchValue) && maxBatchValue > 0);
  const maxBatchChanged =
    maxBatchValid &&
    maxBatchInput !== '' &&
    Math.round(maxBatchValue) !== (override?.maxBatchSize ?? -1);

  const hasAnyOverride =
    override?.shelfLifeDays !== undefined || override?.maxBatchSize !== undefined;

  return (
    <div
      style={{
        marginBottom: 14,
        padding: 10,
        background: hasAnyOverride ? '#eff6ff' : 'var(--bg-page)',
        border: '0.5px solid var(--border)',
        borderRadius: 4,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginBottom: 8,
        }}
      >
        Product overrides
      </div>

      {/* Shelf life */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 11, marginBottom: 3 }}>
          <span>Shelf life (days)</span>
          <span style={{ color: 'var(--text-muted)' }}>
            default: {globalShelfLifeDays}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="number"
            min={1}
            placeholder={`${globalShelfLifeDays}`}
            value={shelfLifeInput}
            onChange={(e) => setShelfLifeInput(e.target.value)}
            style={{
              flex: 1,
              padding: '5px 8px',
              fontSize: 12,
              border: '0.5px solid var(--border)',
              borderRadius: 3,
              fontFamily: 'inherit',
              background: 'var(--bg-page)',
              color: 'inherit',
            }}
          />
          <button
            type="button"
            onClick={() => postOverride('shelfLifeDays', shelfLifeValue)}
            disabled={!shelfLifeValid || !shelfLifeChanged || saving !== null}
            style={{
              padding: '5px 10px',
              fontSize: 11,
              border: '0.5px solid var(--border)',
              borderRadius: 3,
              background: shelfLifeChanged ? '#dbeafe' : 'var(--bg-page)',
              color: shelfLifeChanged ? '#1e40af' : 'var(--text-muted)',
              cursor: shelfLifeChanged && saving === null ? 'pointer' : 'default',
              fontFamily: 'inherit',
            }}
          >
            {saving === 'shelfLife' ? 'Saving…' : saved === 'shelfLife' ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </div>

      {/* Max batch */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 11, marginBottom: 3 }}>
          <span>Max batch (units)</span>
          <span style={{ color: 'var(--text-muted)' }}>
            default: {stationDailyOutput || '—'} (1 day station output)
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="number"
            min={1}
            placeholder={stationDailyOutput ? String(stationDailyOutput) : ''}
            value={maxBatchInput}
            onChange={(e) => setMaxBatchInput(e.target.value)}
            style={{
              flex: 1,
              padding: '5px 8px',
              fontSize: 12,
              border: '0.5px solid var(--border)',
              borderRadius: 3,
              fontFamily: 'inherit',
              background: 'var(--bg-page)',
              color: 'inherit',
            }}
          />
          <button
            type="button"
            onClick={() => postOverride('maxBatchSize', maxBatchValue)}
            disabled={!maxBatchValid || !maxBatchChanged || saving !== null}
            style={{
              padding: '5px 10px',
              fontSize: 11,
              border: '0.5px solid var(--border)',
              borderRadius: 3,
              background: maxBatchChanged ? '#dbeafe' : 'var(--bg-page)',
              color: maxBatchChanged ? '#1e40af' : 'var(--text-muted)',
              cursor: maxBatchChanged && saving === null ? 'pointer' : 'default',
              fontFamily: 'inherit',
            }}
          >
            {saving === 'maxBatch' ? 'Saving…' : saved === 'maxBatch' ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ fontSize: 11, color: '#dc2626', marginBottom: 6 }}>⚠ {error}</div>
      )}

      {saved && !error && (
        <div style={{ fontSize: 11, color: '#1e40af', marginBottom: 6 }}>
          Saved. Click <strong>Re-plan</strong> in the header to apply.
        </div>
      )}

      {hasAnyOverride && (
        <button
          type="button"
          onClick={clearAllOverrides}
          disabled={saving !== null}
          style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            background: 'transparent',
            border: 'none',
            cursor: saving !== null ? 'default' : 'pointer',
            padding: 0,
            fontFamily: 'inherit',
            textDecoration: 'underline',
          }}
        >
          Clear all overrides for this product
        </button>
      )}
    </div>
  );
}

// ─── Bottom-strip panels (Phase 4e) ──────────────────────────

function CapacityHeatmap({
  data,
}: {
  data: {
    weekStarts: string[];
    byWeek: Map<string, Map<Station, { peakUtilisation: number; totalMinutes: number }>>;
    /** Per-week kitchen-team utilisation (Phase 4l.7). */
    kitchenByWeek: Map<string, { peakUtilisation: number; totalMinutes: number }>;
  };
}) {
  function color(util: number): string {
    if (util <= 0) return 'var(--bg-page)';
    if (util > 1) return '#dc2626';
    if (util > 0.85) return '#d97706';
    if (util > 0.5) return '#10b981';
    if (util > 0.2) return '#86efac';
    return '#d1fae5';
  }

  return (
    <section
      style={{
        background: 'var(--bg-surface)',
        border: '0.5px solid var(--border)',
        borderRadius: 6,
        padding: 14,
      }}
    >
      <h3 style={{ fontSize: 12, fontWeight: 500, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>
        Capacity heatmap (peak day per week)
      </h3>
      <div style={{ display: 'grid', gridTemplateColumns: `auto repeat(${data.weekStarts.length}, 1fr)`, gap: 1, fontSize: 10 }}>
        {/* Header row: week labels */}
        <div />
        {data.weekStarts.map((ws, i) => (
          <div
            key={ws}
            style={{
              textAlign: 'center',
              padding: '2px 0',
              color: 'var(--text-muted)',
            }}
            title={`Week of ${fmtDate(ws)}`}
          >
            W{i + 1}
          </div>
        ))}
        {STATIONS.map((s) => (
          <Fragment key={s}>
            <div
              style={{
                fontSize: 11,
                paddingRight: 10,
                color: 'var(--text-secondary)',
                whiteSpace: 'nowrap',
              }}
            >
              {STATION_LABELS[s]}
            </div>
            {data.weekStarts.map((ws) => {
              const cell = data.byWeek.get(ws)?.get(s);
              const util = cell?.peakUtilisation ?? 0;
              return (
                <div
                  key={ws + s}
                  style={{
                    height: 18,
                    background: color(util),
                    borderRadius: 1,
                  }}
                  title={`${STATION_LABELS[s]} · week of ${fmtDate(ws)}: peak ${Math.round(util * 100)}%, total ${Math.round(cell?.totalMinutes ?? 0)} min`}
                />
              );
            })}
          </Fragment>
        ))}

        {/* Kitchen-team row (Phase 4l.7). Visually separated from the
            packaging stations by a gap row above the cells. */}
        <Fragment>
          <div
            style={{
              fontSize: 11,
              paddingRight: 10,
              paddingTop: 4,
              color: 'var(--text-secondary)',
              whiteSpace: 'nowrap',
              fontStyle: 'italic',
            }}
          >
            Kitchen team
          </div>
          {data.weekStarts.map((ws) => {
            const cell = data.kitchenByWeek.get(ws);
            const util = cell?.peakUtilisation ?? 0;
            return (
              <div
                key={ws + 'kitchen'}
                style={{
                  height: 18,
                  marginTop: 4,
                  background: color(util),
                  borderRadius: 1,
                }}
                title={`Kitchen team · week of ${fmtDate(ws)}: peak ${Math.round(util * 100)}%, total ${Math.round(cell?.totalMinutes ?? 0)} min (8 hr/day budget)`}
              />
            );
          })}
        </Fragment>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, fontSize: 10, color: 'var(--text-muted)', alignItems: 'center' }}>
        <span>Idle</span>
        <span style={{ width: 12, height: 8, background: '#d1fae5', display: 'inline-block', borderRadius: 1 }} />
        <span style={{ width: 12, height: 8, background: '#86efac', display: 'inline-block', borderRadius: 1 }} />
        <span style={{ width: 12, height: 8, background: '#10b981', display: 'inline-block', borderRadius: 1 }} />
        <span style={{ width: 12, height: 8, background: '#d97706', display: 'inline-block', borderRadius: 1 }} />
        <span style={{ width: 12, height: 8, background: '#dc2626', display: 'inline-block', borderRadius: 1 }} />
        <span>Overrun</span>
      </div>
    </section>
  );
}

function StockoutPanel({
  infeasibleProducts,
}: {
  infeasibleProducts: InfeasibleProduct[];
}) {
  const top = infeasibleProducts.slice(0, 8);
  const maxUnmet = top.length > 0 ? Math.max(...top.map((p) => p.unmetUnits)) : 1;
  return (
    <section
      style={{
        background: 'var(--bg-surface)',
        border: '0.5px solid var(--border)',
        borderRadius: 6,
        padding: 14,
      }}
    >
      <h3 style={{ fontSize: 12, fontWeight: 500, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>
        Stockout risk
      </h3>
      {top.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          No infeasible products — every SKU has a workable plan.
        </div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {top.map((p) => {
            const pct = (p.unmetUnits / maxUnmet) * 100;
            return (
              <li
                key={p.productCode}
                style={{
                  marginBottom: 6,
                  fontSize: 11,
                }}
                title={p.reason}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span style={{ fontWeight: 500 }}>{p.productCode}</span>
                  <span style={{ color: '#991b1b' }}>{p.unmetUnits.toLocaleString()} units</span>
                </div>
                <div
                  style={{
                    height: 4,
                    background: 'var(--bg-page)',
                    borderRadius: 1,
                  }}
                >
                  <div
                    style={{
                      width: `${pct}%`,
                      height: '100%',
                      background: '#dc2626',
                      borderRadius: 1,
                    }}
                  />
                </div>
              </li>
            );
          })}
          {infeasibleProducts.length > top.length && (
            <li style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              + {infeasibleProducts.length - top.length} more in left-rail panel
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/**
 * Raw-material risks (Phase 4m.1).
 *
 * One row per material that's projected to run short within the planning
 * horizon. Each row shows:
 *   - Material code + name
 *   - Required arrival date (1 day before first shortage)
 *   - PO place-by date (= arriveBy − lead time)
 *   - Quantity short
 *   - Overdue flag when placeBy is already in the past
 *
 * The panel sorts most-urgent first (overdue rows at top, then by placeBy
 * date ascending). Clicking a row could open a per-material drilldown in a
 * future phase; for now the row is informational.
 */
function RawMaterialRiskPanel({
  shortages,
  requirements,
}: {
  shortages: RawMaterialShortage[];
  requirements: PurchaseRequirement[];
}) {
  // Index shortages by code so the requirement row can show the demand
  // context (initial SOH, total demand, drivers).
  const shortageByCode = new Map<string, RawMaterialShortage>();
  for (const s of shortages) shortageByCode.set(s.rawMaterialCode, s);

  // Sort: overdue first, then by placeBy ascending.
  const ordered = [...requirements].sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    return a.placeByDate.localeCompare(b.placeByDate);
  });
  const overdueCount = ordered.filter((r) => r.overdue).length;

  return (
    <section
      style={{
        background: 'var(--bg-surface)',
        border: '0.5px solid var(--border)',
        borderRadius: 6,
        padding: 14,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 10,
        }}
      >
        <h3
          style={{
            fontSize: 12,
            fontWeight: 500,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: 'var(--text-muted)',
            margin: 0,
          }}
        >
          Raw material risks &middot; {ordered.length} PO{ordered.length === 1 ? '' : 's'} needed
        </h3>
        {overdueCount > 0 && (
          <span style={{ fontSize: 11, color: '#dc2626', fontWeight: 500 }}>
            ⚠ {overdueCount} overdue
          </span>
        )}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
        Default lead time 14 days. Place-by dates assume the kitchen needs the
        material 1 day before its first shortage. Per-vendor lead times can be
        wired in later.
      </div>
      <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
            <th style={cellStyle}>Material</th>
            <th style={cellStyle}>Place by</th>
            <th style={cellStyle}>Arrive by</th>
            <th style={{ ...cellStyle, textAlign: 'right' }}>Qty</th>
            <th style={{ ...cellStyle, textAlign: 'right' }}>SOH</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((r) => {
            const s = shortageByCode.get(r.rawMaterialCode);
            return (
              <tr
                key={r.rawMaterialCode}
                title={
                  s
                    ? `Initial SOH ${s.initialSoh.toLocaleString()}, total demand ${Math.round(s.totalDemand).toLocaleString()}, first shortage ${fmtDate(s.shortageDate)}.`
                    : undefined
                }
                style={{
                  borderTop: '0.5px solid var(--border)',
                  background: r.overdue ? '#fef2f2' : 'transparent',
                }}
              >
                <td style={cellStyle}>
                  <div style={{ fontWeight: 500 }}>{r.rawMaterialCode}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>
                    {r.rawMaterialName}
                  </div>
                </td>
                <td
                  style={{
                    ...cellStyle,
                    color: r.overdue ? '#dc2626' : 'inherit',
                    fontWeight: r.overdue ? 600 : 400,
                  }}
                >
                  {fmtDate(r.placeByDate)}
                  {r.overdue && (
                    <span style={{ marginLeft: 4, fontSize: 10 }}>⚠</span>
                  )}
                </td>
                <td style={cellStyle}>{fmtDate(r.arriveByDate)}</td>
                <td style={{ ...cellStyle, textAlign: 'right' }}>
                  {Math.round(r.quantity).toLocaleString()}
                </td>
                <td
                  style={{
                    ...cellStyle,
                    textAlign: 'right',
                    color: 'var(--text-muted)',
                  }}
                >
                  {s ? Math.round(s.initialSoh).toLocaleString() : '–'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

const cellStyle: React.CSSProperties = {
  padding: '6px 8px',
  verticalAlign: 'top',
  fontWeight: 'normal',
};

function Field({
  label,
  value,
  modified,
  originalValue,
}: {
  label: string;
  value: string;
  modified?: boolean;
  originalValue?: string;
}) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div
        style={{
          marginTop: 2,
          color: modified ? '#1e40af' : 'inherit',
          fontWeight: modified ? 500 : 400,
        }}
      >
        {value}
      </div>
      {modified && originalValue && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', textDecoration: 'line-through' }}>
          {originalValue}
        </div>
      )}
    </div>
  );
}
