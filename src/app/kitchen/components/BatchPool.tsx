'use client';

import { useState, useMemo } from 'react';
import { BatchCard } from './BatchCard';
import type { UnscheduledBatchSlot } from '../hooks/useKitchenPlanner';

interface BatchPoolProps {
  unscheduledBatches: {
    secondary: UnscheduledBatchSlot[];
    topLevel: UnscheduledBatchSlot[];
  };
  onBatchDragStart: (key: string) => void;
  onBatchClick: (key: string) => void;
}

function matchesFilter(slot: UnscheduledBatchSlot, query: string): boolean {
  const q = query.toLowerCase();
  const name = slot.intermediate.name.toLowerCase();
  const code = slot.intermediate.code.toLowerCase();
  const num = (slot.intermediate.assemblyNumber || '').toLowerCase();
  return name.includes(q) || code.includes(q) || num.includes(q);
}

export function BatchPool({
  unscheduledBatches,
  onBatchDragStart,
  onBatchClick,
}: BatchPoolProps) {
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    if (!filter.trim()) return unscheduledBatches;
    return {
      secondary: unscheduledBatches.secondary.filter(s => matchesFilter(s, filter)),
      topLevel: unscheduledBatches.topLevel.filter(s => matchesFilter(s, filter)),
    };
  }, [unscheduledBatches, filter]);

  const hasSecondary = filtered.secondary.length > 0;
  const hasTopLevel = filtered.topLevel.length > 0;
  const totalAll =
    unscheduledBatches.secondary.length + unscheduledBatches.topLevel.length;
  const totalFiltered =
    filtered.secondary.length + filtered.topLevel.length;

  return (
    <div className="overflow-y-auto flex flex-col" style={{ background: 'var(--bg-page)' }}>
      <div
        className="sticky top-0 px-4 py-3 space-y-2"
        style={{ background: 'var(--bg-surface)', borderBottom: '0.5px solid var(--border)' }}
      >
        <div>
          <h2 style={{ fontWeight: 500, color: 'var(--text-primary)' }}>Batch Pool</h2>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            {filter.trim()
              ? `${totalFiltered} of ${totalAll} assemblies`
              : `${totalAll} assembl${totalAll !== 1 ? 'ies' : 'y'}`}
          </p>
        </div>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search name, code, or assembly #"
          className="w-full px-3 py-1.5 rounded text-sm placeholder:opacity-40 focus:outline-none transition"
          style={{
            color: 'var(--text-primary)',
            background: 'var(--bg-page)',
            border: '0.5px solid var(--border)',
          }}
        />
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Secondary (schedule first) */}
        {hasSecondary && (
          <div>
            <h3
              className="text-[11px] uppercase tracking-wider mb-3"
              style={{ fontWeight: 500, color: 'var(--text-muted)' }}
            >
              Secondary (schedule first)
            </h3>
            <div className="space-y-2">
              {filtered.secondary.map((slot) => (
                <div key={slot.intermediateKey}>
                  <BatchCard
                    intermediateKey={slot.intermediateKey}
                    deadline={slot.intermediate.deadline}
                    variant="sidebar"
                    onDragStart={onBatchDragStart}
                    onClick={() => onBatchClick(slot.intermediateKey)}
                  />
                  {slot.isScheduled && (
                    <div
                      className="mt-1 text-[10px] px-2 py-1 rounded text-center uppercase tracking-wide"
                      style={{ fontWeight: 600, background: 'var(--accent)', color: 'white' }}
                    >
                      {slot.scheduledDate
                        ? `On calendar · ${slot.scheduledDate.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}`
                        : 'On calendar'}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Top-level intermediates */}
        {hasTopLevel && (
          <div>
            <h3
              className="text-[11px] uppercase tracking-wider mb-3"
              style={{ fontWeight: 500, color: 'var(--text-muted)' }}
            >
              Top-level intermediates
            </h3>
            <div className="space-y-2">
              {filtered.topLevel.map((slot) => (
                <div key={slot.intermediateKey}>
                  <BatchCard
                    intermediateKey={slot.intermediateKey}
                    deadline={slot.intermediate.deadline}
                    variant="sidebar"
                    onDragStart={onBatchDragStart}
                    onClick={() => onBatchClick(slot.intermediateKey)}
                  />
                  {slot.isScheduled && (
                    <div
                      className="mt-1 text-[10px] px-2 py-1 rounded text-center uppercase tracking-wide"
                      style={{ fontWeight: 600, background: 'var(--accent)', color: 'white' }}
                    >
                      {slot.scheduledDate
                        ? `On calendar · ${slot.scheduledDate.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}`
                        : 'On calendar'}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {!hasSecondary && !hasTopLevel && (
          <div className="text-center py-12">
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {filter.trim() ? 'No matching assemblies' : 'No assemblies found'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
