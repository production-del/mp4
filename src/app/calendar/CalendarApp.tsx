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

import { Fragment, useEffect, useMemo, useState, useTransition } from 'react';
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
  clearStale,
  staleStableIds,
  readMutationsFromStorage,
  writeMutationsToStorage,
  type MutationsMap,
} from '@/lib/planning/calendar-mutations';
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

interface CalendarAppProps {
  horizon: PlanningHorizon;
  activities: CalendarActivity[];
  dayLoads: DayLoadSummary[];
  /** Per-station daily capacity in minutes. Used for client-side load recompute. */
  stationDailyMinutes: Record<string, number>;
  infeasibleProducts: InfeasibleProduct[];
  /** productCode → cost-router rationale string (why this station was chosen). */
  routingDecisions: Record<string, string>;
  summary: SummaryProps;
}

// ─── Constants ───────────────────────────────────────────────

const STATIONS: Station[] = ['hand-packing', 'elephant', 'dust', 'bottlo'];

const STATION_COLORS: Record<Station, { bg: string; border: string; text: string; dot: string }> = {
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

function fmtDate(iso: string): string {
  const d = fromISO(iso);
  return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
}

// ─── Component ───────────────────────────────────────────────

export function CalendarApp(props: CalendarAppProps) {
  const { horizon, activities, dayLoads, stationDailyMinutes, infeasibleProducts, routingDecisions, summary } = props;
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

  // Layer-toggle state: which stations are visible. Default all on.
  const [visibleStations, setVisibleStations] = useState<Set<Station>>(
    () => new Set(STATIONS),
  );

  // Selected activity for the drawer.
  const [selected, setSelected] = useState<CalendarActivity | null>(null);

  // ─── Mutations (dismiss) ─────────────────────────────────
  // Hydrated from localStorage on mount; written on every mutation.
  const [mutations, setMutations] = useState<MutationsMap>({});
  const [showDismissed, setShowDismissed] = useState(true);

  useEffect(() => {
    setMutations(readMutationsFromStorage());
  }, []);

  // Mutation actions — every one writes through to localStorage immediately.
  function persist(next: MutationsMap) {
    writeMutationsToStorage(next);
    return next;
  }
  function dismiss(stableId: string) {
    setMutations((curr) => persist(applyDismiss(curr, stableId)));
  }
  function undismiss(stableId: string) {
    setMutations((curr) => persist(applyUndismiss(curr, stableId)));
  }
  function reschedule(stableId: string, newDate: string) {
    setMutations((curr) => persist(applyReschedule(curr, stableId, newDate)));
  }
  function clearReschedule(stableId: string) {
    setMutations((curr) => persist(applyClearReschedule(curr, stableId)));
  }
  function editQuantity(stableId: string, qty: number) {
    setMutations((curr) => persist(applyEditQuantity(curr, stableId, qty)));
  }
  function clearEdit(stableId: string) {
    setMutations((curr) => persist(applyClearEdit(curr, stableId)));
  }
  function clearStaleMutations() {
    setMutations((curr) => persist(clearStale(curr, validStableIds)));
  }

  // Set of stable IDs in the current engine output — used to detect stale
  // mutation entries (entries whose activity no longer exists in the plan).
  const validStableIds = useMemo(
    () => new Set(activities.map((a) => a.stableId)),
    [activities],
  );

  const staleIds = useMemo(
    () => staleStableIds(mutations, validStableIds),
    [mutations, validStableIds],
  );

  // Apply mutations to each activity: override date if rescheduled, override
  // quantity if edited (with proportional duration adjustment). Dismiss is
  // applied later by the visibility filter.
  const mutatedActivities = useMemo(() => {
    return activities.map((a) => {
      const mut = mutations[a.stableId];
      if (!mut || (mut.rescheduledTo === undefined && mut.editedQuantity === undefined)) {
        return a;
      }
      const newQty = mut.editedQuantity ?? a.quantity;
      const newDate = mut.rescheduledTo ?? a.date;
      const durationScale = a.quantity > 0 ? newQty / a.quantity : 1;
      return {
        ...a,
        quantity: newQty,
        date: newDate,
        durationMinutes: a.durationMinutes * durationScale,
        // changeoverMinutes is product+neighbour-dependent, not quantity-dependent
      };
    });
  }, [activities, mutations]);

  // Number of dismissed activities present in the current plan.
  const dismissedCount = useMemo(
    () => activities.filter((a) => isDismissed(mutations, a.stableId)).length,
    [activities, mutations],
  );

  // Filter mutated activities through layer toggles + dismissal visibility.
  const visibleActivities = useMemo(() => {
    return mutatedActivities.filter((a) => {
      if (!visibleStations.has(a.station)) return false;
      if (!showDismissed && isDismissed(mutations, a.stableId)) return false;
      return true;
    });
  }, [mutatedActivities, visibleStations, mutations, showDismissed]);
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
  }, [mutatedActivities, visibleStations, mutations, stationDailyMinutes]);

  // Per-station counts (for the chip labels in the rail) — count BEFORE
  // filtering so the user can see what they'd un-hide.
  const stationCounts = useMemo(() => {
    const counts: Record<Station, number> = {
      'hand-packing': 0,
      elephant: 0,
      dust: 0,
      bottlo: 0,
    };
    for (const a of activities) counts[a.station] += 1;
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
  const heatmapByWeek = useMemo(() => {
    type Cell = { peakUtilisation: number; totalMinutes: number };
    const usedByDateStation = new Map<string, Map<Station, number>>();
    for (const a of mutatedActivities) {
      if (isDismissed(mutations, a.stableId)) continue;
      let stMap = usedByDateStation.get(a.date);
      if (!stMap) {
        stMap = new Map();
        usedByDateStation.set(a.date, stMap);
      }
      stMap.set(a.station, (stMap.get(a.station) ?? 0) + a.durationMinutes + a.changeoverMinutes);
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
      out.set(ws, stationMap);
    }
    return { weekStarts, byWeek: out };
  }, [mutatedActivities, mutations, horizon, stationDailyMinutes]);

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
                  padding: '6px 0',
                  fontSize: 13,
                  cursor: 'pointer',
                  opacity: on ? 1 : 0.4,
                  userSelect: 'none',
                }}
              >
                <input type="checkbox" checked={on} onChange={() => toggleStation(s)} />
                <span
                  style={{
                    width: 10,
                    height: 10,
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

        <Section title="Data">
          <KPIRow
            label="Demand source"
            value={summary.demandSourceMtime ? new Date(summary.demandSourceMtime).toLocaleDateString('en-AU') : '—'}
          />
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
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              {horizon.weeks}-week horizon from {fmtDate(horizon.startWeek)}
            </span>
            <button
              type="button"
              onClick={replan}
              disabled={isReplanning}
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
            onSelect={setSelected}
            selectedId={selected?.id ?? null}
            mutations={mutations}
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
      </main>

      {/* ─── Right drawer ──────────────────────────────── */}
      {selected && (
        <ActivityDrawer
          // We always render the drawer against the LATEST data: look up the
          // original activity in `activities` (the server-rendered list) and
          // overlay any current mutation. Selected gets stale when mutations
          // happen otherwise.
          activity={selected}
          original={activities.find((a) => a.stableId === selected.stableId) ?? selected}
          routingRationale={routingDecisions[selected.productCode] ?? null}
          dismissed={isDismissed(mutations, selected.stableId)}
          rescheduledTo={rescheduledTo(mutations, selected.stableId)}
          editedQuantity={editedQuantityOf(mutations, selected.stableId)}
          stationDailyMinutes={stationDailyMinutes[selected.station] ?? 480}
          onDismiss={() => dismiss(selected.stableId)}
          onUndismiss={() => undismiss(selected.stableId)}
          onReschedule={(date) => reschedule(selected.stableId, date)}
          onClearReschedule={() => clearReschedule(selected.stableId)}
          onEditQuantity={(qty) => editQuantity(selected.stableId, qty)}
          onClearEdit={() => clearEdit(selected.stableId)}
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
  onSelect,
  selectedId,
  mutations,
}: {
  label: string;
  dates: string[];
  activitiesByDate: Map<string, CalendarActivity[]>;
  peakLoadByDate: Map<string, { utilisation: number; usedMinutes: number; capacityMinutes: number; station: Station }>;
  onSelect: (a: CalendarActivity) => void;
  selectedId: string | null;
  mutations: MutationsMap;
}) {
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
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          border: '0.5px solid var(--border)',
          borderRadius: 6,
          overflow: 'hidden',
          background: 'var(--bg-surface)',
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
          const overrun = peakLoad ? peakLoad.utilisation > 1 : false;
          return (
            <div
              key={cell.date}
              style={{
                minHeight: 110,
                padding: 4,
                borderRight: '0.5px solid var(--border)',
                borderBottom: '0.5px solid var(--border)',
                background: isWeekend ? 'var(--bg-page)' : 'transparent',
                opacity: isWeekend ? 0.5 : 1,
                position: 'relative',
                outline: overrun ? '1.5px solid #dc2626' : 'none',
                outlineOffset: -1,
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
              {dayActivities.map((a) => (
                <ActivityChip
                  key={a.id}
                  activity={a}
                  selected={a.id === selectedId}
                  dismissed={isDismissed(mutations, a.stableId)}
                  onClick={() => onSelect(a)}
                />
              ))}
              {peakLoad && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: 0,
                    left: 0,
                    right: 0,
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
          );
        })}
      </div>
    </div>
  );
}

function ActivityChip({
  activity,
  selected,
  dismissed,
  onClick,
}: {
  activity: CalendarActivity;
  selected: boolean;
  dismissed: boolean;
  onClick: () => void;
}) {
  const colors = STATION_COLORS[activity.station];
  return (
    <button
      type="button"
      onClick={onClick}
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
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        opacity: dismissed ? 0.35 : 1,
        textDecoration: dismissed ? 'line-through' : 'none',
      }}
      title={
        dismissed
          ? `${activity.productCode} — ${activity.productName} — DISMISSED (${activity.quantity} units, ${Math.round(activity.durationMinutes)} min)`
          : `${activity.productCode} — ${activity.productName} (${activity.quantity} units, ${Math.round(activity.durationMinutes)} min)`
      }
    >
      <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {activity.productCode} <span style={{ opacity: 0.7 }}>×{activity.quantity}</span>
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
  stationDailyMinutes,
  onDismiss,
  onUndismiss,
  onReschedule,
  onClearReschedule,
  onEditQuantity,
  onClearEdit,
  onClose,
}: {
  activity: CalendarActivity;
  /** The unmutated activity from the server output — used to display "original" values. */
  original: CalendarActivity;
  routingRationale: string | null;
  dismissed: boolean;
  rescheduledTo: string | null;
  editedQuantity: number | null;
  stationDailyMinutes: number;
  onDismiss: () => void;
  onUndismiss: () => void;
  onReschedule: (newDate: string) => void;
  onClearReschedule: () => void;
  onEditQuantity: (qty: number) => void;
  onClearEdit: () => void;
  onClose: () => void;
}) {
  const colors = STATION_COLORS[activity.station];

  // Working days within the activity's week (Mon-Fri) for the reschedule picker.
  const weekDays = useMemo(() => {
    const out: { iso: string; label: string }[] = [];
    const monday = fromISO(original.weekStart);
    for (let i = 0; i < 5; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      out.push({
        iso: toISO(d),
        label: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'][i],
      });
    }
    return out;
  }, [original.weekStart]);

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
        {STATION_LABELS[activity.station]}
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
          label="Date"
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
        <Field label="Production" value={`${Math.round(activity.durationMinutes)} min`} />
        <Field
          label="Changeover"
          value={`${Math.round(activity.changeoverMinutes)} min`}
        />
        <Field label="Family" value={activity.family ?? '—'} />
        <Field label="Extended family" value={activity.extendedFamily ?? '—'} />
      </div>

      {/* ─── Reschedule picker ─────────────────────────── */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
          Reschedule (within week)
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {weekDays.map((d) => {
            const isCurrent = d.iso === activity.date;
            const isOriginal = d.iso === original.date;
            return (
              <button
                key={d.iso}
                type="button"
                onClick={() => onReschedule(d.iso)}
                disabled={isCurrent}
                style={{
                  flex: 1,
                  padding: '6px 4px',
                  fontSize: 11,
                  border: `0.5px solid ${isCurrent ? colors.border : 'var(--border)'}`,
                  borderRadius: 3,
                  background: isCurrent ? colors.bg : 'var(--bg-page)',
                  color: isCurrent ? colors.text : 'var(--text-secondary)',
                  fontWeight: isCurrent ? 500 : 400,
                  cursor: isCurrent ? 'default' : 'pointer',
                  fontFamily: 'inherit',
                }}
                title={
                  isCurrent
                    ? 'Currently scheduled here'
                    : isOriginal
                    ? `Original: ${d.label}`
                    : `Move to ${d.label}`
                }
              >
                {d.label}
                {isOriginal && !isCurrent && <span style={{ opacity: 0.5 }}> *</span>}
              </button>
            );
          })}
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

      {/* Action buttons. Dismiss/Undismiss is the only action wired in 4d.1;
          edit + reschedule come in 4d.2. */}
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

// ─── Bottom-strip panels (Phase 4e) ──────────────────────────

function CapacityHeatmap({
  data,
}: {
  data: {
    weekStarts: string[];
    byWeek: Map<string, Map<Station, { peakUtilisation: number; totalMinutes: number }>>;
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
            title={`Week of ${ws}`}
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
                  title={`${STATION_LABELS[s]} · week of ${ws}: peak ${Math.round(util * 100)}%, total ${Math.round(cell?.totalMinutes ?? 0)} min`}
                />
              );
            })}
          </Fragment>
        ))}
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
