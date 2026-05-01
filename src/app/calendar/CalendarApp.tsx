'use client';

/**
 * CalendarApp — Phase 4a client component.
 *
 * Reads pre-computed projection data from the server component and renders:
 *   - A 12-week month-by-month calendar grid with activity chips per day
 *   - Per-station layer toggles (left rail)
 *   - Coverage / changeover summary KPIs (left rail)
 *   - Read-only activity drawer (right rail) when a chip is clicked
 *
 * No state mutation yet — edit / reschedule / dismiss / re-plan all come
 * in Phase 4b. This phase proves the rendering pipeline against real data.
 *
 * Layout: 3-column flex (left rail / main calendar / right drawer). The
 * drawer collapses to nothing when no activity is selected so the calendar
 * can use the full width.
 */

import { useMemo, useState } from 'react';
import type {
  CalendarActivity,
  DayLoadSummary,
} from '@/lib/planning/calendar-projection';
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
  const { horizon, activities, dayLoads, infeasibleProducts, routingDecisions, summary } = props;
  const [infeasibleOpen, setInfeasibleOpen] = useState(false);

  // Layer-toggle state: which stations are visible. Default all on.
  const [visibleStations, setVisibleStations] = useState<Set<Station>>(
    () => new Set(STATIONS),
  );

  // Selected activity for the drawer.
  const [selected, setSelected] = useState<CalendarActivity | null>(null);

  // Filter activities through the layer toggles.
  const visibleActivities = useMemo(
    () => activities.filter((a) => visibleStations.has(a.station)),
    [activities, visibleStations],
  );
  const activitiesByDate = useMemo(
    () => groupByDate(visibleActivities),
    [visibleActivities],
  );

  // Aggregate per-day load across visible stations: peak utilisation per day.
  // Used to render the per-cell load indicator.
  const peakLoadByDate = useMemo(() => {
    const out = new Map<string, { utilisation: number; usedMinutes: number; capacityMinutes: number; station: Station }>();
    for (const dl of dayLoads) {
      if (!visibleStations.has(dl.station)) continue;
      const existing = out.get(dl.date);
      if (!existing || dl.utilisation > existing.utilisation) {
        out.set(dl.date, {
          utilisation: dl.utilisation,
          usedMinutes: dl.usedMinutes,
          capacityMinutes: dl.capacityMinutes,
          station: dl.station,
        });
      }
    }
    return out;
  }, [dayLoads, visibleStations]);

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
    <div style={{ display: 'flex', minHeight: 'calc(100vh - 130px)' }}>
      {/* ─── Left rail ─────────────────────────────────── */}
      <aside
        style={{
          width: 260,
          padding: 16,
          borderRight: '0.5px solid var(--border)',
          background: 'var(--bg-surface)',
          flexShrink: 0,
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
        <div style={{ marginBottom: 16, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>Production Calendar</h1>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            {horizon.weeks}-week horizon from {fmtDate(horizon.startWeek)}
          </span>
        </div>

        {monthGroups.map((group) => (
          <MonthBlock
            key={group.monthKey}
            label={group.label}
            dates={group.dates}
            activitiesByDate={activitiesByDate}
            peakLoadByDate={peakLoadByDate}
            onSelect={setSelected}
            selectedId={selected?.id ?? null}
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
      </main>

      {/* ─── Right drawer ──────────────────────────────── */}
      {selected && (
        <ActivityDrawer
          activity={selected}
          routingRationale={routingDecisions[selected.productCode] ?? null}
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
}: {
  label: string;
  dates: string[];
  activitiesByDate: Map<string, CalendarActivity[]>;
  peakLoadByDate: Map<string, { utilisation: number; usedMinutes: number; capacityMinutes: number; station: Station }>;
  onSelect: (a: CalendarActivity) => void;
  selectedId: string | null;
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
  onClick,
}: {
  activity: CalendarActivity;
  selected: boolean;
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
      }}
      title={`${activity.productCode} — ${activity.quantity} units (${Math.round(activity.durationMinutes)} min)`}
    >
      {activity.productCode} <span style={{ opacity: 0.7 }}>×{activity.quantity}</span>
    </button>
  );
}

function ActivityDrawer({
  activity,
  routingRationale,
  onClose,
}: {
  activity: CalendarActivity;
  routingRationale: string | null;
  onClose: () => void;
}) {
  const colors = STATION_COLORS[activity.station];
  return (
    <aside
      style={{
        width: 320,
        padding: 20,
        borderLeft: '0.5px solid var(--border)',
        background: 'var(--bg-surface)',
        flexShrink: 0,
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
        <Field label="Date" value={fmtDate(activity.date)} />
        <Field label="Quantity" value={`${activity.quantity}`} />
        <Field label="Production" value={`${Math.round(activity.durationMinutes)} min`} />
        <Field
          label="Changeover"
          value={`${Math.round(activity.changeoverMinutes)} min`}
        />
        <Field label="Family" value={activity.family ?? '—'} />
        <Field label="Extended family" value={activity.extendedFamily ?? '—'} />
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

      <div
        style={{
          marginTop: 4,
          padding: 10,
          background: 'var(--bg-page)',
          borderRadius: 4,
          fontSize: 11,
          color: 'var(--text-muted)',
        }}
      >
        Edit / reschedule / dismiss come in the next iteration.
      </div>
    </aside>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{ marginTop: 2 }}>{value}</div>
    </div>
  );
}
