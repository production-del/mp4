'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useKitchenDataContext } from '../context/KitchenDataContext';
import { INTERMEDIATE_REGISTRY } from '../data/intermediate-registry';
import type { DraftPO } from '../../purchasing/hooks/usePurchasingPlanner';
import type { PurchaseOrderItem } from '@/lib/planning/plan-item';
import { listByKind, replaceByKind } from '@/lib/planning/plan-draft-store';
import { fromLocalISODate, toLocalISODate } from '@/lib/planning/working-day';

interface ComponentModalProps {
  intermediateCode: string | null;
  onClose: () => void;
}

// --- Draft PO persistence (shared facade over PlanDraftStore) ---

function loadDraftPOs(): DraftPO[] {
  // Only items still in 'draft' lifecycle. Pushed items are already in
  // Unleashed and will come back via the live PO fetch — keeping them here
  // too would double-count their quantity in the projection.
  return listByKind('purchase_order')
    .filter(i => i.lifecycle === 'draft')
    .map(i => ({
      id: i.id,
      componentCode: i.productCode,
      componentName: i.productName,
      supplierId: i.supplierId,
      supplierName: i.supplierName,
      deliveryDate: fromLocalISODate(i.deliveryDate),
      quantity: i.quantity,
    }));
}

function saveDraftPOs(drafts: DraftPO[]): void {
  const items: PurchaseOrderItem[] = drafts.map(d => ({
    kind: 'purchase_order',
    id: d.id,
    productCode: d.componentCode,
    productName: d.componentName,
    quantity: d.quantity,
    lifecycle: 'draft',
    deliveryDate: toLocalISODate(d.deliveryDate),
    supplierId: d.supplierId,
    supplierName: d.supplierName,
  }));
  replaceByKind('purchase_order', items);
}

// --- Draft Transfer persistence (shared with logistics page) ---

import type { DraftTransfer } from '@/lib/planning/transfer-types';
import { loadDraftTransfers, saveDraftTransfers } from '@/lib/planning/transfer-store';

// --- Helpers ---

/** Date -> "YYYY-MM-DD" (local timezone, not UTC) */
function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Is this date a weekday? */
function isWeekday(d: Date): boolean {
  const day = d.getDay();
  return day !== 0 && day !== 6;
}

/** Next calendar day */
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** Next weekday after d */
function nextWorkingDay(d: Date): Date {
  let next = addDays(d, 1);
  while (!isWeekday(next)) next = addDays(next, 1);
  return next;
}

/** Short label: "6 Apr" */
function shortDate(d: Date): string {
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

// --- Daily projection for one component ---

/** One line-item contributing to consumption or production on a day */
interface DayDetail {
  label: string;          // e.g. "Almonds Activated (AS-00015485)" or "Packaging: Walnuts MED+LRG"
  kg: number;
  type: 'consumed' | 'produced';
}

interface ProjectionDay {
  date: Date;
  dateKey: string;
  soh: number;
  consumed: number;   // consumed by batches on this day
  produced: number;    // production arriving this day (from prior-day batches)
  isWorkday: boolean;
  details: DayDetail[];  // itemised breakdown for tooltip
}

/**
 * One inbound-stock line to show on a component card in the Components list.
 * `source` drives both the ordering label ("Open PO", "Partial PO", "Draft PO",
 * "Transfer") and a subtle colour cue so live-vs-draft is distinguishable.
 */
interface IncomingStockItem {
  source: 'po-open' | 'po-partial' | 'po-draft' | 'transfer';
  date: Date;
  quantity: number;
  label: string; // supplier (PO) or from-warehouse (transfer)
}

const INCOMING_SOURCE_META: Record<
  IncomingStockItem['source'],
  { label: string; color: string; bg: string }
> = {
  'po-open': { label: 'Open PO', color: 'var(--success)', bg: 'var(--success-light)' },
  'po-partial': { label: 'Partial PO', color: 'var(--success)', bg: 'var(--success-light)' },
  'po-draft': { label: 'Draft PO', color: 'var(--accent)', bg: 'var(--accent-light)' },
  'transfer': { label: 'Transfer', color: 'var(--warning)', bg: 'var(--warning-light)' },
};

/**
 * For a batch that starts on `scheduledDate` and runs for `durationDays`
 * calendar days, return the day its output becomes available downstream.
 * Single-day batches behave as they always did (ready next working day).
 * Multi-day batches push availability out by `durationDays - 1` days so
 * the output only shows in stock on the LAST processing day (bumped to
 * the next working day if that lands on a weekend).
 */
function getBatchAvailabilityDate(scheduledDate: Date, durationDays: number | undefined): Date {
  const lastProcessingDay = addDays(scheduledDate, Math.max(0, (durationDays ?? 1) - 1));
  return nextWorkingDay(lastProcessingDay);
}

function buildProjection(
  componentCode: string,
  startingSoh: number,
  blockStart: Date,
  blockEnd: Date,
  scheduledBatches: { productCode: string; productName: string; quantity: number; scheduledDate: Date; assemblyNumber?: string }[],
  intermediates: Record<string, { code: string; name?: string; components: Record<string, number>; batchSize: number; durationDays?: number }>,
  packagingDeadlines: { date: string; label?: string; demandKg?: Record<string, number> }[] = [],
  draftPOs: DraftPO[] = [],
): ProjectionDay[] {
  // Build per-day consumption map: dateKey -> total consumed
  // A batch scheduled on date D consumes componentCode if its BOM includes it
  const consumptionByDay = new Map<string, number>();
  const productionByDay = new Map<string, number>(); // dateKey -> qty arriving
  const detailsByDay = new Map<string, DayDetail[]>();

  const pushDetail = (dk: string, detail: DayDetail) => {
    const arr = detailsByDay.get(dk) || [];
    arr.push(detail);
    detailsByDay.set(dk, arr);
  };

  for (const batch of scheduledBatches) {
    const dk = toDateKey(batch.scheduledDate);
    const batchLabel = batch.productName + (batch.assemblyNumber ? ` (${batch.assemblyNumber})` : '');

    // Check if this batch consumes our component
    // Find any intermediate whose code matches batch.productCode
    const inter = Object.values(intermediates).find(i => i.code === batch.productCode);
    if (inter && inter.components[componentCode]) {
      const ratio = inter.components[componentCode];
      const consumed = ratio * batch.quantity;
      consumptionByDay.set(dk, (consumptionByDay.get(dk) || 0) + consumed);
      pushDetail(dk, { label: batchLabel, kg: consumed, type: 'consumed' });
    }

    // Check if this batch produces our component.
    // Multi-day batches (e.g., Brazil nuts at 2 days in the dehydrator)
    // release their output on the LAST day of processing — not the day
    // they start.
    if (batch.productCode === componentCode) {
      const producer = Object.values(intermediates).find(
        (i) => i.code === batch.productCode,
      );
      const availDate = getBatchAvailabilityDate(batch.scheduledDate, producer?.durationDays);
      const adk = toDateKey(availDate);
      productionByDay.set(adk, (productionByDay.get(adk) || 0) + batch.quantity);
      pushDetail(adk, { label: batchLabel, kg: batch.quantity, type: 'produced' });
    }
  }

  // Add packaging demand: packaging runs consume the intermediate (componentCode)
  // on their scheduled date. demandKg maps intermediateCode -> kg needed.
  for (const deadline of packagingDeadlines) {
    const kg = deadline.demandKg?.[componentCode];
    if (kg && kg > 0) {
      consumptionByDay.set(
        deadline.date,
        (consumptionByDay.get(deadline.date) || 0) + kg
      );
      pushDetail(deadline.date, {
        label: `Packaging: ${deadline.label || 'run'}`,
        kg,
        type: 'consumed',
      });
    }
  }

  // Add draft purchase-order deliveries: each PO bumps SOH on its delivery
  // date for the component it's ordering. Matches on `componentCode` so an
  // intermediate projection (productCode == componentCode) is unaffected —
  // POs only feed the component (raw material) view by design.
  for (const po of draftPOs) {
    if (po.componentCode !== componentCode) continue;
    if (!(po.deliveryDate instanceof Date) || isNaN(po.deliveryDate.getTime())) continue;
    if (!po.quantity || po.quantity <= 0) continue;
    const dk = toDateKey(po.deliveryDate);
    productionByDay.set(dk, (productionByDay.get(dk) || 0) + po.quantity);
    pushDetail(dk, {
      label: `PO${po.supplierName ? `: ${po.supplierName}` : ''}`,
      kg: po.quantity,
      type: 'produced',
    });
  }

  // Walk each day from blockStart to blockEnd
  const days: ProjectionDay[] = [];
  let running = startingSoh;
  const current = new Date(blockStart);
  current.setHours(0, 0, 0, 0);
  const end = new Date(blockEnd);
  end.setHours(23, 59, 59, 999);

  while (current <= end) {
    const dk = toDateKey(current);
    const wd = isWeekday(current);
    const produced = productionByDay.get(dk) || 0;
    const consumed = wd ? (consumptionByDay.get(dk) || 0) : 0;

    running = running + produced - consumed;

    days.push({
      date: new Date(current),
      dateKey: dk,
      soh: running,
      consumed,
      produced,
      isWorkday: wd,
      details: wd ? (detailsByDay.get(dk) || []) : [],
    });

    current.setDate(current.getDate() + 1);
  }

  return days;
}

// --- Interactive SVG chart ---

interface SOHChartProps {
  days: ProjectionDay[];
  componentName: string;
}

function SOHChart({ days, componentName }: SOHChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Only show working days on the chart
  const workdays = days.filter(d => d.isWorkday);
  if (workdays.length === 0) return null;

  const W = 540;
  const H = 220;
  const PAD = { top: 20, right: 20, bottom: 40, left: 55 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const values = workdays.map(d => d.soh);
  const minVal = Math.min(0, ...values);
  const maxVal = Math.max(...values, 1);
  const range = maxVal - minVal || 1;

  const x = (i: number) => PAD.left + (i / Math.max(workdays.length - 1, 1)) * plotW;
  const y = (v: number) => PAD.top + plotH - ((v - minVal) / range) * plotH;

  // Build polyline path
  const linePath = workdays.map((_, i) => `${x(i)},${y(values[i])}`).join(' ');

  // Zero line position
  const zeroY = y(0);

  // Gradient fill under the line
  const areaPath = `M${x(0)},${y(values[0])} ${workdays.map((_, i) => `L${x(i)},${y(values[i])}`).join(' ')} L${x(workdays.length - 1)},${zeroY} L${x(0)},${zeroY} Z`;

  // X-axis labels -- show every Nth to avoid crowding
  const labelInterval = Math.max(1, Math.ceil(workdays.length / 8));

  const hovered = hoverIdx !== null ? workdays[hoverIdx] : null;

  // Theme-aware chart colors via CSS custom properties
  const lineColor = 'var(--chart-soh)';
  const areaStartColor = 'var(--chart-soh)';
  const productionColor = 'var(--chart-production)';
  const consumptionColor = 'var(--chart-consumed)';
  const negativeColor = 'var(--chart-min)';
  const gridColor = 'var(--chart-grid)';
  const labelColor = 'var(--chart-label)';
  const axisColor = 'var(--chart-axis)';

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full rounded"
        style={{ background: 'var(--bg-page)', border: '0.5px solid var(--border)' }}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {/* Grid lines */}
        {[0.25, 0.5, 0.75, 1].map(frac => {
          const gy = PAD.top + plotH * (1 - frac);
          return (
            <line key={frac} x1={PAD.left} x2={W - PAD.right} y1={gy} y2={gy}
              stroke={gridColor} strokeWidth={0.5} strokeDasharray="4 4" />
          );
        })}

        {/* Zero line if visible */}
        {minVal < 0 && (
          <line x1={PAD.left} x2={W - PAD.right} y1={zeroY} y2={zeroY}
            stroke={negativeColor} strokeWidth={1} strokeDasharray="6 3" opacity={0.5} />
        )}

        {/* Area fill */}
        <defs>
          <linearGradient id="sohGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={areaStartColor} stopOpacity={0.15} />
            <stop offset="100%" stopColor={areaStartColor} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#sohGrad)" />

        {/* Line */}
        <polyline
          points={linePath}
          fill="none"
          stroke={lineColor}
          strokeWidth={2}
          strokeLinejoin="round"
        />

        {/* Production markers (blue) */}
        {workdays.map((d, i) => d.produced > 0 ? (
          <g key={`prod-${i}`}>
            <circle cx={x(i)} cy={y(values[i])} r={4} fill={productionColor} />
            <text x={x(i)} y={y(values[i]) - 8} textAnchor="middle"
              fill={productionColor} fontSize={8} fontWeight="500">
              +{Math.round(d.produced)}
            </text>
          </g>
        ) : null)}

        {/* Consumption markers (orange) */}
        {workdays.map((d, i) => d.consumed > 0 ? (
          <g key={`cons-${i}`}>
            <circle cx={x(i)} cy={y(values[i])} r={4} fill={consumptionColor} />
            <text x={x(i)} y={y(values[i]) + 14} textAnchor="middle"
              fill={consumptionColor} fontSize={8} fontWeight="500">
              -{Math.round(d.consumed)}
            </text>
          </g>
        ) : null)}

        {/* Data points — only on days with a transaction or SOH change */}
        {workdays.map((d, i) => {
          const hasEvent = d.produced > 0 || d.consumed > 0 || (i > 0 && values[i] !== values[i - 1]);
          if (!hasEvent) return null;
          // Skip if already covered by a production or consumption marker
          if (d.produced > 0 || d.consumed > 0) return null;
          return (
            <circle key={i} cx={x(i)} cy={y(values[i])} r={3}
              fill={values[i] < 0 ? negativeColor : lineColor} />
          );
        })}

        {/* X-axis labels */}
        {workdays.map((d, i) => i % labelInterval === 0 ? (
          <text key={`xl-${i}`} x={x(i)} y={H - PAD.bottom + 16}
            textAnchor="middle" fill={labelColor} fontSize={9}>
            {shortDate(d.date)}
          </text>
        ) : null)}

        {/* Y-axis labels */}
        {[0, 0.25, 0.5, 0.75, 1].map(frac => {
          const val = minVal + range * frac;
          return (
            <text key={`yl-${frac}`} x={PAD.left - 6} y={PAD.top + plotH * (1 - frac) + 3}
              textAnchor="end" fill={labelColor} fontSize={9}>
              {Math.round(val)}
            </text>
          );
        })}

        {/* Axis labels */}
        <text x={W / 2} y={H - 4} textAnchor="middle" fill={axisColor} fontSize={10}>
          Working Days
        </text>
        <text x={12} y={H / 2} textAnchor="middle" fill={axisColor} fontSize={10}
          transform={`rotate(-90 12 ${H / 2})`}>
          SOH (kg)
        </text>

        {/* Hover crosshair */}
        {hoverIdx !== null && (
          <line x1={x(hoverIdx)} x2={x(hoverIdx)} y1={PAD.top} y2={PAD.top + plotH}
            stroke={labelColor} strokeWidth={1} strokeDasharray="3 3" opacity={0.4} />
        )}

        {/* Invisible hover areas for each point */}
        {workdays.map((_, i) => (
          <rect
            key={`hover-${i}`}
            x={x(i) - plotW / workdays.length / 2}
            y={PAD.top}
            width={plotW / workdays.length}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => setHoverIdx(i)}
          />
        ))}
      </svg>

      {/* Tooltip */}
      {hovered && hoverIdx !== null && (
        <div
          className="absolute pointer-events-none rounded px-3 py-2 text-xs max-w-[260px]"
          style={{
            left: `${(x(hoverIdx) / W) * 100}%`,
            top: 0,
            transform: hoverIdx > workdays.length * 0.7 ? 'translateX(-110%)' : 'translateX(-50%)',
            background: 'var(--bg-page)',
            border: '0.5px solid var(--border)',
          }}
        >
          <p style={{ fontWeight: 500, color: 'var(--text-primary)' }} className="mb-1">
            {hovered.date.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}
          </p>
          <p style={{ color: 'var(--text-secondary)' }}>
            SOH: <span style={{ fontWeight: 500, color: hovered.soh < 0 ? 'var(--danger)' : 'var(--success)' }}>
              {Math.round(hovered.soh * 100) / 100} kg
            </span>
          </p>
          {hovered.consumed > 0 && (
            <p style={{ color: consumptionColor }}>
              Consumed: -{Math.round(hovered.consumed * 100) / 100} kg
            </p>
          )}
          {hovered.produced > 0 && (
            <p style={{ color: productionColor }}>
              Produced: +{Math.round(hovered.produced * 100) / 100} kg
            </p>
          )}
          {hovered.details.length > 0 && (
            <div className="mt-1.5 pt-1.5 space-y-0.5" style={{ borderTop: '0.5px solid var(--border)' }}>
              {hovered.details.map((d, i) => (
                <p key={i} style={{ color: d.type === 'produced' ? productionColor : consumptionColor }}>
                  <span style={{ fontWeight: 500 }}>{d.type === 'produced' ? '+' : '-'}{Math.round(d.kg)} kg</span>
                  {' '}
                  <span style={{ color: 'var(--text-muted)' }}>{d.label}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Modal ---

export function ComponentModal({ intermediateCode, onClose }: ComponentModalProps) {
  const {
    intermediates, componentSOH, perProductSOH, components, scheduledBatches,
    blockStart, blockEnd, packagingDeadlines, openPOLines,
  } = useKitchenDataContext();
  const [selectedComponent, setSelectedComponent] = useState<string | null>(null);
  const [showDraftPO, setShowDraftPO] = useState(false);
  const [draftPOs, setDraftPOs] = useState<DraftPO[]>([]);
  const [draftDate, setDraftDate] = useState('');
  const [draftQtyStr, setDraftQtyStr] = useState('500');
  const [draftSupplier, setDraftSupplier] = useState('');
  const [draftSaved, setDraftSaved] = useState(false);

  // Transfer state
  const [showDraftTransfer, setShowDraftTransfer] = useState(false);
  const [draftTransfers, setDraftTransfers] = useState<DraftTransfer[]>([]);
  const [transferDate, setTransferDate] = useState('');
  const [transferQtyStr, setTransferQtyStr] = useState('');
  const [transferFrom, setTransferFrom] = useState('');
  const [transferSaved, setTransferSaved] = useState(false);

  // Load existing draft POs and transfers on mount
  useEffect(() => {
    setDraftPOs(loadDraftPOs());
    setDraftTransfers(loadDraftTransfers());
  }, []);

  // Open the draft PO form with sensible defaults
  const openDraftPOForm = useCallback(() => {
    const twoWeeks = new Date();
    twoWeeks.setDate(twoWeeks.getDate() + 14);
    setDraftDate(toDateKey(twoWeeks));
    setDraftQtyStr('500');
    setDraftSupplier('');
    setShowDraftPO(true);
  }, []);

  const addDraftPO = useCallback((componentCode: string, componentName: string, deliveryDate: Date, quantity: number, supplierName: string) => {
    const newDraft: DraftPO = {
      id: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      componentCode,
      componentName,
      supplierId: '',
      supplierName,
      deliveryDate,
      quantity,
    };
    setDraftPOs((prev) => {
      const next = [...prev, newDraft];
      saveDraftPOs(next);
      return next;
    });
    setDraftSaved(true);
    setTimeout(() => setDraftSaved(false), 2000);
  }, []);

  const removeDraftPO = useCallback((id: string) => {
    setDraftPOs((prev) => {
      const next = prev.filter((d) => d.id !== id);
      saveDraftPOs(next);
      return next;
    });
  }, []);

  // Transfer handlers
  const openDraftTransferForm = useCallback(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    setTransferDate(toDateKey(tomorrow));
    setTransferQtyStr('');
    setTransferFrom('');
    setShowDraftTransfer(true);
    setShowDraftPO(false); // close PO form if open
  }, []);

  const addDraftTransfer = useCallback((componentCode: string, componentName: string, fromWarehouse: string, quantity: number, date: Date) => {
    const newTransfer: DraftTransfer = {
      id: `transfer-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      productCode: componentCode,
      productName: componentName,
      fromWarehouse,
      toWarehouse: 'Lundberg Storeroom',
      quantity,
      transferDate: date,
      needByDate: date,
      status: 'draft',
      reason: 'Kitchen batch requirement',
    };
    setDraftTransfers((prev) => {
      const next = [...prev, newTransfer];
      saveDraftTransfers(next);
      return next;
    });
    setTransferSaved(true);
    setTimeout(() => setTransferSaved(false), 2000);
  }, []);

  const removeDraftTransfer = useCallback((id: string) => {
    setDraftTransfers((prev) => {
      const next = prev.filter((d) => d.id !== id);
      saveDraftTransfers(next);
      return next;
    });
  }, []);

  const intermediate = intermediateCode
    ? intermediates[intermediateCode]
    : null;

  const componentCodes = intermediate ? Object.keys(intermediate.components) : [];
  const firstComponent = selectedComponent || componentCodes[0] || '';
  const componentSoh = componentSOH[firstComponent] || 0;

  // Find this batch's scheduled date (for time-aware planned production)
  const thisBatch = useMemo(() =>
    scheduledBatches.find(b => b.intermediateKey === intermediateCode),
    [scheduledBatches, intermediateCode]
  );
  const batchDate = thisBatch?.scheduledDate ?? null;

  // Build time-aware planned production map:
  // Only count production from batches whose output arrives by this batch's
  // date. Multi-day batches release on their LAST processing day (see
  // `getBatchAvailabilityDate`), so a 2-day batch starting Monday doesn't
  // help a run scheduled for the same Monday.
  const plannedProduction = useMemo(() => {
    const planned: Record<string, number> = {};
    for (const batch of scheduledBatches) {
      // Skip this batch itself
      if (thisBatch && batch.id === thisBatch.id) continue;
      const producer = Object.values(intermediates).find(
        (i) => i.code === batch.productCode,
      );
      const availDate = getBatchAvailabilityDate(batch.scheduledDate, producer?.durationDays);
      // Only count if output arrives on or before this batch's date
      if (batchDate && availDate > batchDate) continue;
      const code = batch.productCode;
      planned[code] = (planned[code] || 0) + batch.quantity;
    }
    return planned;
  }, [scheduledBatches, batchDate, thisBatch, intermediates]);

  // Merge live open PO lines from Unleashed with local draft POs. Each live
  // line is shaped as a DraftPO so `buildProjection` can treat both uniformly.
  // Live lines use a synthetic id prefixed with `live-` to keep them distinct
  // from draft-store ids if any downstream caller ever needs to tell them apart.
  const poSupplyForProjection = useMemo((): DraftPO[] => {
    const live: DraftPO[] = (openPOLines ?? []).map((line, idx) => ({
      id: `live-${line.purchaseOrderNumber}-${idx}`,
      componentCode: line.productCode,
      componentName: components[line.productCode]?.name || line.productCode,
      supplierId: '',
      supplierName: line.supplierName,
      deliveryDate: fromLocalISODate(line.deliveryDate),
      quantity: line.quantity,
    }));
    return [...live, ...draftPOs];
  }, [openPOLines, draftPOs, components]);

  // Build SOH projection for the intermediate product itself. POs by design
  // target component (raw material) codes, not intermediates, so the PO list
  // is passed but will typically have no effect here — the filter in
  // `buildProjection` discards non-matching POs.
  const intermediateProjection = useMemo(() => {
    if (!intermediate) return [];
    return buildProjection(
      intermediate.code,
      componentSOH[intermediate.code] || 0,
      blockStart,
      blockEnd,
      scheduledBatches,
      intermediates,
      packagingDeadlines,
      poSupplyForProjection,
    );
  }, [intermediate, componentSOH, blockStart, blockEnd, scheduledBatches, intermediates, packagingDeadlines, poSupplyForProjection]);

  // Build SOH projection for selected component
  const projection = useMemo(() => {
    if (!firstComponent) return [];
    return buildProjection(
      firstComponent,
      componentSOH[firstComponent] || 0,
      blockStart,
      blockEnd,
      scheduledBatches,
      intermediates,
      packagingDeadlines,
      poSupplyForProjection,
    );
  }, [firstComponent, componentSOH, blockStart, blockEnd, scheduledBatches, intermediates, packagingDeadlines, poSupplyForProjection]);

  // Draft POs for the currently selected component
  const componentDrafts = useMemo(
    () => draftPOs.filter((d) => d.componentCode === firstComponent),
    [draftPOs, firstComponent]
  );

  // Incoming-stock items per component, rolled up from live + draft POs and
  // draft transfers, filtered to deliveries falling inside the block window
  // (matches the projection chart's visible range). Sorted by date ascending
  // so operators see the next arrival first.
  const incomingByComponent = useMemo(() => {
    const blockStartMs = blockStart.getTime();
    const blockEndMs = blockEnd.getTime();
    const map = new Map<string, IncomingStockItem[]>();
    const push = (code: string, item: IncomingStockItem) => {
      const arr = map.get(code) || [];
      arr.push(item);
      map.set(code, arr);
    };

    // Live open / partially-received POs
    for (const line of openPOLines ?? []) {
      const d = fromLocalISODate(line.deliveryDate);
      if (isNaN(d.getTime())) continue;
      if (d.getTime() < blockStartMs || d.getTime() > blockEndMs) continue;
      push(line.productCode, {
        source: line.status === 'PartiallyReceived' ? 'po-partial' : 'po-open',
        date: d,
        quantity: line.quantity,
        label: line.supplierName || line.purchaseOrderNumber,
      });
    }

    // Local draft POs (lifecycle 'draft' only — see loadDraftPOs)
    for (const po of draftPOs) {
      if (!(po.deliveryDate instanceof Date) || isNaN(po.deliveryDate.getTime())) continue;
      if (po.deliveryDate.getTime() < blockStartMs || po.deliveryDate.getTime() > blockEndMs) continue;
      push(po.componentCode, {
        source: 'po-draft',
        date: po.deliveryDate,
        quantity: po.quantity,
        label: po.supplierName || 'draft PO',
      });
    }

    // Draft transfers (always inbound to Lundberg in this workflow)
    for (const t of draftTransfers) {
      if (!(t.transferDate instanceof Date) || isNaN(t.transferDate.getTime())) continue;
      if (t.transferDate.getTime() < blockStartMs || t.transferDate.getTime() > blockEndMs) continue;
      push(t.productCode, {
        source: 'transfer',
        date: t.transferDate,
        quantity: t.quantity,
        label: t.fromWarehouse || 'transfer',
      });
    }

    for (const [, arr] of map) arr.sort((a, b) => a.date.getTime() - b.date.getTime());
    return map;
  }, [openPOLines, draftPOs, draftTransfers, blockStart, blockEnd]);

  // Draft transfers for the currently selected component
  const componentTransfers = useMemo(
    () => draftTransfers.filter((d) => d.productCode === firstComponent),
    [draftTransfers, firstComponent]
  );

  // Close draft forms when switching components
  useEffect(() => {
    setShowDraftPO(false);
    setShowDraftTransfer(false);
  }, [firstComponent]);

  // Early return AFTER all hooks
  if (!intermediateCode || !intermediate) return null;

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        style={{ background: 'var(--bg-page)', border: '0.5px solid var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="sticky top-0 px-6 py-4 flex items-center justify-between"
          style={{ background: 'var(--bg-page)', borderBottom: '0.5px solid var(--border)' }}
        >
          <div>
            <h2 className="text-xl" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
              {intermediate.name}
            </h2>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{intermediate.code}</p>
          </div>
          <button
            onClick={onClose}
            className="text-2xl transition hover:opacity-60"
            style={{ color: 'var(--text-muted)' }}
          >
            x
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Process panel — equipment, run duration, prep lead-time, prep
              notes. Surfaces the details encoded in Kitchen Parameters so
              operators know how long this batch will tie up a dehydrator
              unit and what has to happen the day(s) before. */}
          <ProcessPanel intermediate={intermediate} />

          {/* Intermediate Product SOH Projection */}
          <div>
            <h3 style={{ fontWeight: 500, color: 'var(--text-primary)' }} className="mb-1">
              {intermediate.name} -- SOH Projection
            </h3>
            <div className="flex items-center gap-4 text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
              <span>
                Current SOH: <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{Math.round(componentSOH[intermediate.code] || 0)} kg</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full" style={{ background: 'var(--chart-soh)' }} /> SOH
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full" style={{ background: 'var(--chart-production)' }} /> Production
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full" style={{ background: 'var(--chart-consumed)' }} /> Consumed
              </span>
            </div>
            <SOHChart
              days={intermediateProjection}
              componentName={intermediate.name}
            />
          </div>

          {/* Component SOH Projection Chart */}
          {firstComponent && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <h3 style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                  Component Projection -- {components[firstComponent]?.name || firstComponent}
                </h3>
                {(() => {
                  const isComponentIntermediate = firstComponent in INTERMEDIATE_REGISTRY;
                  const draftLabel = isComponentIntermediate ? 'Draft Assembly' : 'Draft PO';
                  return (
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => {
                          if (showDraftTransfer) { setShowDraftTransfer(false); return; }
                          openDraftTransferForm();
                        }}
                        className="px-3 py-1.5 text-xs rounded transition"
                        style={
                          showDraftTransfer
                            ? { fontWeight: 500, color: 'var(--text-secondary)', background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }
                            : { fontWeight: 500, color: 'var(--warning)', background: 'var(--warning-light)', border: '0.5px solid var(--warning)' }
                        }
                      >
                        {transferSaved ? '✓ Saved!' : showDraftTransfer ? 'Cancel' : `Draft Transfer${componentTransfers.length ? ` (${componentTransfers.length})` : ''}`}
                      </button>
                      <button
                        onClick={() => {
                          if (showDraftPO) { setShowDraftPO(false); return; }
                          setShowDraftTransfer(false);
                          openDraftPOForm();
                        }}
                        className="px-3 py-1.5 text-xs rounded transition"
                        style={
                          showDraftPO
                            ? { fontWeight: 500, color: 'var(--text-secondary)', background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }
                            : { fontWeight: 500, color: '#fff', background: 'var(--accent)' }
                        }
                      >
                        {draftSaved ? '✓ Saved!' : showDraftPO ? 'Cancel' : `${draftLabel}${componentDrafts.length ? ` (${componentDrafts.length})` : ''}`}
                      </button>
                    </div>
                  );
                })()}
              </div>
              <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
                Select a component below to view its projection
              </p>

              {/* Draft PO / Assembly inline form */}
              {showDraftPO && (() => {
                const isComponentIntermediate = firstComponent in INTERMEDIATE_REGISTRY;
                const draftLabel = isComponentIntermediate ? 'Assembly' : 'PO';
                return (
                <div
                  className="mb-4 p-4 rounded-lg space-y-3"
                  style={{ background: 'var(--accent-light)', border: '0.5px solid var(--accent)' }}
                >
                  <div className={`grid gap-3 ${isComponentIntermediate ? 'grid-cols-2' : 'grid-cols-3'}`}>
                    {!isComponentIntermediate && (
                      <div>
                        <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>Supplier</label>
                        <input
                          type="text"
                          value={draftSupplier}
                          onChange={(e) => setDraftSupplier(e.target.value)}
                          placeholder="e.g. Honest to Goodness"
                          className="w-full rounded px-3 py-1.5 text-sm focus:outline-none"
                          style={{ border: '0.5px solid var(--border)', background: 'var(--bg-page)', color: 'var(--text-primary)' }}
                        />
                      </div>
                    )}
                    <div>
                      <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>
                        {isComponentIntermediate ? 'Assembly Date' : 'Delivery Date'}
                      </label>
                      <input
                        type="date"
                        value={draftDate}
                        onChange={(e) => setDraftDate(e.target.value)}
                        className="w-full rounded px-3 py-1.5 text-sm focus:outline-none"
                        style={{ border: '0.5px solid var(--border)', background: 'var(--bg-page)', color: 'var(--text-primary)' }}
                      />
                    </div>
                    <div>
                      <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>Quantity (kg)</label>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={draftQtyStr}
                        onChange={(e) => setDraftQtyStr(e.target.value)}
                        className="w-full rounded px-3 py-1.5 text-sm focus:outline-none"
                        style={{ border: '0.5px solid var(--border)', background: 'var(--bg-page)', color: 'var(--text-primary)' }}
                      />
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <button
                      disabled={!draftDate || !draftQtyStr || Number(draftQtyStr) <= 0}
                      onClick={() => {
                        addDraftPO(
                          firstComponent,
                          components[firstComponent]?.name || firstComponent,
                          new Date(draftDate),
                          Number(draftQtyStr),
                          isComponentIntermediate ? '' : draftSupplier.trim()
                        );
                        setShowDraftPO(false);
                      }}
                      className="px-4 py-1.5 rounded text-sm text-white transition disabled:opacity-30 disabled:cursor-not-allowed"
                      style={{ fontWeight: 500, background: 'var(--accent)' }}
                    >
                      Add Draft {draftLabel}
                    </button>
                  </div>

                  {/* Existing drafts for this component */}
                  {componentDrafts.length > 0 && (
                    <div className="pt-3" style={{ borderTop: '0.5px solid var(--accent)' }}>
                      <p className="text-xs mb-2" style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>
                        Existing draft {draftLabel}s for {firstComponent}:
                      </p>
                      <div className="space-y-1">
                        {componentDrafts.map((d) => (
                          <div
                            key={d.id}
                            className="flex items-center justify-between rounded px-3 py-1.5 text-xs"
                            style={{ background: 'var(--bg-page)', border: '0.5px solid var(--border)' }}
                          >
                            <span style={{ color: 'var(--text-primary)' }}>
                              {Math.round(d.quantity)} kg on{' '}
                              {d.deliveryDate.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}
                              {d.supplierName && (
                                <span style={{ color: 'var(--text-muted)' }}> -- {d.supplierName}</span>
                              )}
                            </span>
                            <button
                              onClick={() => removeDraftPO(d.id)}
                              className="transition hover:opacity-70"
                              style={{ fontWeight: 500, color: 'var(--danger)' }}
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                );
              })()}

              {/* Draft Transfer inline form */}
              {showDraftTransfer && (
                <div
                  className="mb-4 p-4 rounded-lg space-y-3"
                  style={{ background: 'var(--warning-light)', border: '0.5px solid var(--warning)' }}
                >
                  <div className="grid gap-3 grid-cols-3">
                    <div>
                      <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>From Warehouse</label>
                      <select
                        value={transferFrom}
                        onChange={(e) => setTransferFrom(e.target.value)}
                        className="w-full rounded px-3 py-1.5 text-sm focus:outline-none"
                        style={{ border: '0.5px solid var(--border)', background: 'var(--bg-page)', color: 'var(--text-primary)' }}
                      >
                        <option value="">Select...</option>
                        <option value="MF Packaging">MF Packaging</option>
                        <option value="MF Operations">MF Operations</option>
                        <option value="TBC">TBC</option>
                        <option value="TBC Height">TBC Height</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>Transfer Date</label>
                      <input
                        type="date"
                        value={transferDate}
                        onChange={(e) => setTransferDate(e.target.value)}
                        className="w-full rounded px-3 py-1.5 text-sm focus:outline-none"
                        style={{ border: '0.5px solid var(--border)', background: 'var(--bg-page)', color: 'var(--text-primary)' }}
                      />
                    </div>
                    <div>
                      <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>Quantity (kg)</label>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={transferQtyStr}
                        onChange={(e) => setTransferQtyStr(e.target.value)}
                        className="w-full rounded px-3 py-1.5 text-sm focus:outline-none"
                        style={{ border: '0.5px solid var(--border)', background: 'var(--bg-page)', color: 'var(--text-primary)' }}
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      → Lundberg Storeroom
                    </span>
                    <button
                      disabled={!transferFrom || !transferDate || !transferQtyStr || Number(transferQtyStr) <= 0}
                      onClick={() => {
                        addDraftTransfer(
                          firstComponent,
                          components[firstComponent]?.name || firstComponent,
                          transferFrom,
                          Number(transferQtyStr),
                          new Date(transferDate)
                        );
                        setShowDraftTransfer(false);
                      }}
                      className="px-4 py-1.5 rounded text-sm text-white transition disabled:opacity-30 disabled:cursor-not-allowed"
                      style={{ fontWeight: 500, background: 'var(--warning)' }}
                    >
                      Add Draft Transfer
                    </button>
                  </div>

                  {/* Existing transfers for this component */}
                  {componentTransfers.length > 0 && (
                    <div className="pt-3" style={{ borderTop: '0.5px solid var(--warning)' }}>
                      <p className="text-xs mb-2" style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>
                        Existing draft transfers for {firstComponent}:
                      </p>
                      <div className="space-y-1">
                        {componentTransfers.map((d) => (
                          <div
                            key={d.id}
                            className="flex items-center justify-between rounded px-3 py-1.5 text-xs"
                            style={{ background: 'var(--bg-page)', border: '0.5px solid var(--border)' }}
                          >
                            <span style={{ color: 'var(--text-primary)' }}>
                              {Math.round(d.quantity)} kg from {d.fromWarehouse} on{' '}
                              {d.transferDate.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}
                            </span>
                            <button
                              onClick={() => removeDraftTransfer(d.id)}
                              className="transition hover:opacity-70"
                              style={{ fontWeight: 500, color: 'var(--danger)' }}
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <SOHChart
                days={projection}
                componentName={components[firstComponent]?.name || firstComponent}
              />
            </div>
          )}

          {/* Stats */}
          <div className="grid grid-cols-3 gap-4">
            <div className="rounded p-4" style={{ background: 'var(--bg-surface)' }}>
              <p className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                Net Position
              </p>
              <p className="text-2xl mt-1" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                {(() => {
                  const planned = plannedProduction[firstComponent] || 0;
                  const net = componentSoh + planned - intermediate.demand;
                  return `${net > 0 ? '+' : ''}${Math.round(net * 100) / 100}`;
                })()}
              </p>
            </div>
            <div className="rounded p-4" style={{ background: 'var(--bg-surface)' }}>
              <p className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                Days of Coverage
              </p>
              <p className="text-2xl mt-1" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                {(() => {
                  const planned = plannedProduction[firstComponent] || 0;
                  const dailyRate = intermediate.demand / 20;
                  return dailyRate > 0 ? Math.floor((componentSoh + planned) / dailyRate) : '--';
                })()}
              </p>
            </div>
            <div className="rounded p-4" style={{ background: 'var(--bg-surface)' }}>
              <p className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                Next Delivery
              </p>
              <p className="text-sm mt-2" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                {intermediate.deadline
                  ? new Date(intermediate.deadline).toLocaleDateString('en-AU')
                  : '--'}
              </p>
            </div>
          </div>

          {/* Components */}
          <div>
            <h3 className="mb-3" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>Components</h3>
            <div className="space-y-3">
              {componentCodes.map((code) => {
                const soh = componentSOH[code] || 0;
                const planned = plannedProduction[code] || 0;
                const componentName = components[code]?.name || code;
                const qty = intermediate.components[code];
                const needed = Math.ceil(intermediate.demand * qty);
                const effective = soh + planned;
                const coverage = needed > 0 ? effective / needed : 1;
                let barColor = 'var(--success)';
                if (coverage < 1) barColor = 'var(--danger)';
                else if (coverage < 1.5) barColor = 'var(--warning)';

                return (
                  <div
                    key={code}
                    className="cursor-pointer p-3 rounded transition"
                    style={{
                      backgroundColor:
                        selectedComponent === code ? 'var(--bg-surface)' : 'var(--bg-page)',
                      border: `0.5px solid ${
                        selectedComponent === code ? 'var(--border-strong)' : 'var(--border)'
                      }`,
                    }}
                    onClick={() => setSelectedComponent(code)}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div>
                        <p style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                          {componentName}
                        </p>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          SOH: {Math.round(soh * 100) / 100}
                          {planned > 0 && (
                            <span style={{ color: 'var(--accent)', fontWeight: 500 }}>
                              {' '}+ Planned: {Math.round(planned * 100) / 100}
                            </span>
                          )}
                          {' '}| Need: {needed}
                        </p>
                      </div>
                      <span className="text-sm" style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>
                        {Math.round(coverage * 100)}%
                      </span>
                    </div>
                    {/* Per-warehouse SOH breakdown */}
                    {(() => {
                      const warehouseBreakdown = perProductSOH[code];
                      if (!warehouseBreakdown) return null;
                      const entries = Object.entries(warehouseBreakdown)
                        .filter(([, qty]) => qty > 0)
                        .sort((a, b) => b[1] - a[1]);
                      if (entries.length === 0) return null;
                      return (
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mb-1">
                          {entries.map(([wh, qty]) => (
                            <span key={wh} className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                              {wh || 'Default'}: <span style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>{Math.round(qty * 100) / 100}</span>
                            </span>
                          ))}
                        </div>
                      );
                    })()}
                    {/* Incoming stock — live + draft POs and draft transfers
                        landing within the block window, earliest first. */}
                    {(() => {
                      const incoming = incomingByComponent.get(code);
                      if (!incoming || incoming.length === 0) return null;
                      const totalKg = incoming.reduce((sum, i) => sum + i.quantity, 0);
                      const shown = incoming.slice(0, 3);
                      const hidden = incoming.length - shown.length;
                      return (
                        <div className="mt-1.5 mb-1">
                          <div className="text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>
                            Incoming: <span style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>
                              {Math.round(totalKg * 100) / 100} kg
                            </span>
                            {' '}across {incoming.length} {incoming.length === 1 ? 'delivery' : 'deliveries'}
                          </div>
                          <div className="space-y-0.5">
                            {shown.map((item, idx) => {
                              const meta = INCOMING_SOURCE_META[item.source];
                              return (
                                <div
                                  key={idx}
                                  className="flex items-center gap-2 text-[11px]"
                                  style={{ color: 'var(--text-secondary)' }}
                                >
                                  <span
                                    className="px-1.5 py-0.5 rounded text-[10px] flex-shrink-0"
                                    style={{ fontWeight: 500, background: meta.bg, color: meta.color }}
                                  >
                                    {meta.label}
                                  </span>
                                  <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                                    {Math.round(item.quantity * 100) / 100} kg
                                  </span>
                                  <span>
                                    {item.date.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}
                                  </span>
                                  <span className="truncate" style={{ color: 'var(--text-muted)' }}>
                                    · {item.label}
                                  </span>
                                </div>
                              );
                            })}
                            {hidden > 0 && (
                              <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                +{hidden} more
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                    <div className="w-full rounded h-2" style={{ background: 'var(--bg-hover)' }}>
                      <div
                        className="h-2 rounded transition"
                        style={{
                          width: `${Math.min(coverage * 100, 100)}%`,
                          background: barColor,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Dependencies */}
          {intermediate.requires.length > 0 && (
            <div>
              <h3 className="mb-3" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                Required Intermediates
              </h3>
              <div
                className="rounded p-4 text-sm"
                style={{ background: 'var(--accent-light)', color: 'var(--text-secondary)' }}
              >
                <p>
                  Schedule these first: {intermediate.requires.join(', ')}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Process panel ────────────────────────────────────────────

/**
 * Compact process summary shown at the top of the detail modal:
 * equipment type, run duration, and prep lead-time + notes.
 *
 * All values come from Kitchen Parameters (`IntermediateConfig`). Fields
 * that haven't been configured fall back to sensible defaults — run duration
 * defaults to 1 day, prep defaults to 0. A blend with no prep/duration set
 * still renders the equipment pill so the panel isn't empty.
 */
function ProcessPanel({
  intermediate,
}: {
  intermediate: { name: string; code: string; equipment: string; durationDays?: number; prepDays?: number; prepNotes?: string };
}) {
  const duration = intermediate.durationDays ?? 1;
  const prep = intermediate.prepDays ?? 0;
  const notes = intermediate.prepNotes;

  return (
    <div
      className="rounded p-4 space-y-3"
      style={{ background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }}
    >
      <div className="flex items-center gap-4 text-sm flex-wrap">
        <Stat label="Equipment" value={intermediate.equipment} />
        <Stat
          label="Run duration"
          value={`${duration} day${duration === 1 ? '' : 's'}`}
          hint={duration > 1 ? 'Occupies the lane across this many calendar days' : undefined}
        />
        <Stat
          label="Prep lead-time"
          value={prep === 0 ? 'None' : `${prep} day${prep === 1 ? '' : 's'} before`}
          muted={prep === 0}
        />
      </div>
      {notes ? (
        <div>
          <div
            className="text-[10px] uppercase tracking-wider mb-1"
            style={{ color: 'var(--text-muted)', fontWeight: 600 }}
          >
            Prep notes
          </div>
          <p className="text-sm" style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
            {notes}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  muted,
}: {
  label: string;
  value: string;
  hint?: string;
  muted?: boolean;
}) {
  return (
    <div title={hint}>
      <div
        className="text-[10px] uppercase tracking-wider"
        style={{ color: 'var(--text-muted)', fontWeight: 600 }}
      >
        {label}
      </div>
      <div
        className="text-sm mt-0.5"
        style={{
          fontWeight: 500,
          color: muted ? 'var(--text-muted)' : 'var(--text-primary)',
        }}
      >
        {value}
      </div>
    </div>
  );
}
