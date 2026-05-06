'use client';

import type { DailySOHProjection } from '@/lib/planning/engine-io';

interface ProjectionBarProps {
  projection: DailySOHProjection;
  maxSOH: number;
  safetyStock: number;
  hasDraftPO: boolean;
  onClick: () => void;
}

export function ProjectionBar({
  projection,
  maxSOH,
  safetyStock,
  hasDraftPO,
  onClick,
}: ProjectionBarProps) {
  const { date, closingSOH, consumedQuantity, incomingPOs } = projection;

  // Bar height as percentage of max
  const barPct = maxSOH > 0 ? Math.max(0, (closingSOH / maxSOH) * 100) : 0;
  const safetyPct = maxSOH > 0 ? (safetyStock / maxSOH) * 100 : 0;

  // Color based on stock level
  let barColor = 'var(--success)';
  if (closingSOH <= 0) barColor = 'var(--danger)';
  else if (closingSOH < safetyStock) barColor = 'var(--warning)';

  const dateLabel = date.toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
  });
  const dayName = date.toLocaleDateString('en-AU', { weekday: 'short' });

  return (
    <div
      className="flex flex-col items-center cursor-pointer group min-w-[48px] flex-1"
      onClick={onClick}
      title={`${dateLabel}\nSOH: ${Math.round(closingSOH)}\nConsumed: ${Math.round(consumedQuantity)}\nIncoming: ${Math.round(incomingPOs)}`}
    >
      {/* Bar area */}
      <div className="flex-1 w-full flex flex-col justify-end items-center relative px-1">
        {/* Incoming PO marker */}
        {incomingPOs > 0 && (
          <div
            className="text-xs mb-1"
            style={{ fontWeight: 500, color: hasDraftPO ? 'var(--accent)' : 'var(--accent)' }}
          >
            +{Math.round(incomingPOs)}
          </div>
        )}

        {/* Consumption marker */}
        {consumedQuantity > 0 && (
          <div className="text-xs mb-1" style={{ fontWeight: 500, color: 'var(--danger)' }}>
            -{Math.round(consumedQuantity)}
          </div>
        )}

        {/* The bar */}
        <div
          className="w-full rounded-t transition-all duration-200 group-hover:opacity-70 min-h-[2px]"
          style={{ height: `${Math.max(barPct, 1)}%`, background: barColor }}
        />

        {/* Safety stock line (absolute positioned) */}
        {safetyPct > 0 && safetyPct < 100 && (
          <div
            className="absolute left-0 right-0 pointer-events-none"
            style={{ bottom: `${safetyPct}%`, borderTop: '1px dashed var(--warning)', opacity: 0.4 }}
          />
        )}
      </div>

      {/* SOH label */}
      <div
        className="text-xs font-mono mt-1"
        style={{
          color: closingSOH <= 0 ? 'var(--danger)' : closingSOH < safetyStock ? 'var(--warning)' : 'var(--text-secondary)',
          fontWeight: closingSOH <= 0 || closingSOH < safetyStock ? 500 : 400,
        }}
      >
        {Math.round(closingSOH)}
      </div>

      {/* Date labels */}
      <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{dayName}</div>
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{dateLabel}</div>

      {/* Draft PO indicator */}
      {hasDraftPO && (
        <div className="w-1.5 h-1.5 rounded-full mt-1" style={{ background: 'var(--accent)' }} />
      )}
    </div>
  );
}
