'use client';

import { useMemo } from 'react';
import { ProjectionBar } from './ProjectionBar';
import type { PurchasingProjectionResult } from '@/lib/planning/engine-io';
import type { DraftPO } from '../hooks/usePurchasingPlanner';

interface ProjectionTimelineProps {
  componentCode: string;
  componentName: string;
  soh: number;
  projection: PurchasingProjectionResult;
  drafts: DraftPO[];
  onDayClick: (date: Date) => void;
}

const DEFAULT_SAFETY_STOCK = 50;

export function ProjectionTimeline({
  componentCode,
  componentName,
  soh,
  projection,
  drafts,
  onDayClick,
}: ProjectionTimelineProps) {
  const { projections, risks, recommendedPODate, recommendedQuantity } = projection;

  // Compute max SOH for scaling (use at least 2x safety stock or starting SOH)
  const maxSOH = useMemo(() => {
    let max = soh;
    for (const p of projections) {
      max = Math.max(max, p.closingSOH, p.openingSOH);
    }
    return Math.max(max, DEFAULT_SAFETY_STOCK * 2, 100);
  }, [projections, soh]);

  // Build set of dates with draft POs for indicators
  const draftDates = useMemo(() => {
    const set = new Set<string>();
    for (const d of drafts) {
      set.add(d.deliveryDate.toISOString().split('T')[0]);
    }
    return set;
  }, [drafts]);

  // Summary stats
  const minSOH = useMemo(() => {
    if (projections.length === 0) return soh;
    return Math.min(...projections.map((p) => p.closingSOH));
  }, [projections, soh]);

  const stockoutDate = risks.find((r) => r.riskType === 'stockout')?.date;
  const totalConsumed = projections.reduce((sum, p) => sum + p.consumedQuantity, 0);
  const totalIncoming = projections.reduce((sum, p) => sum + p.incomingPOs, 0);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="p-4" style={{ borderBottom: '0.5px solid var(--border)' }}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-lg" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{componentName}</h2>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{componentCode}</span>
          </div>
          <div className="text-right">
            <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Current SOH: <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{Math.round(soh)}</span>
            </div>
          </div>
        </div>

        {/* Summary row */}
        <div className="flex gap-3 text-xs">
          <div className="rounded px-3 py-1.5" style={{ background: 'var(--bg-surface)' }}>
            <span style={{ color: 'var(--text-muted)' }}>Min SOH: </span>
            <span style={{
              fontWeight: 500,
              color: minSOH <= 0 ? 'var(--danger)' : minSOH < DEFAULT_SAFETY_STOCK ? 'var(--warning)' : 'var(--success)',
            }}>
              {Math.round(minSOH)}
            </span>
          </div>
          <div className="rounded px-3 py-1.5" style={{ background: 'var(--bg-surface)' }}>
            <span style={{ color: 'var(--text-muted)' }}>Total consumed: </span>
            <span style={{ color: 'var(--danger)' }}>{Math.round(totalConsumed)}</span>
          </div>
          <div className="rounded px-3 py-1.5" style={{ background: 'var(--bg-surface)' }}>
            <span style={{ color: 'var(--text-muted)' }}>Total incoming: </span>
            <span style={{ color: 'var(--accent)' }}>{Math.round(totalIncoming)}</span>
          </div>
          {stockoutDate && (
            <div className="rounded px-3 py-1.5" style={{ background: 'var(--danger-light)', border: '0.5px solid var(--danger)' }}>
              <span style={{ color: 'var(--danger)', fontWeight: 500 }}>
                Stockout: {stockoutDate.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}
              </span>
            </div>
          )}
          {recommendedPODate && recommendedQuantity > 0 && (
            <div className="rounded px-3 py-1.5" style={{ background: 'var(--accent-light)', border: '0.5px solid var(--accent)' }}>
              <span style={{ color: 'var(--accent)' }}>
                Suggested PO: {Math.round(recommendedQuantity)} by{' '}
                {recommendedPODate.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Timeline chart */}
      <div className="flex-1 flex items-stretch overflow-x-auto p-4 gap-0.5 min-h-[300px]">
        {projections.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-sm" style={{ color: 'var(--text-muted)' }}>
            No projection data for this period
          </div>
        ) : (
          projections.map((p) => {
            const dateKey = p.date.toISOString().split('T')[0];
            return (
              <ProjectionBar
                key={dateKey}
                projection={p}
                maxSOH={maxSOH}
                safetyStock={DEFAULT_SAFETY_STOCK}
                hasDraftPO={draftDates.has(dateKey)}
                onClick={() => onDayClick(p.date)}
              />
            );
          })
        )}
      </div>

      {/* Legend */}
      <div
        className="px-4 py-2 flex items-center gap-6 text-xs"
        style={{ borderTop: '0.5px solid var(--border)', color: 'var(--text-muted)' }}
      >
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded" style={{ background: 'var(--success)' }} />
          <span>Above safety stock</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded" style={{ background: 'var(--warning)' }} />
          <span>Below safety stock</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded" style={{ background: 'var(--danger)' }} />
          <span>Stockout</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span style={{ color: 'var(--danger)', fontWeight: 500 }}>-N</span>
          <span>Consumption</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span style={{ color: 'var(--accent)', fontWeight: 500 }}>+N</span>
          <span>PO delivery</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
          <span>Draft PO</span>
        </div>
        <div className="ml-auto" style={{ color: 'var(--text-muted)' }}>Click a day to add a draft PO</div>
      </div>
    </div>
  );
}
