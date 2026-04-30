'use client';

import { useState, useRef, useEffect } from 'react';
import { EQUIPMENT_COLORS } from '../data/intermediate-registry';
import { useKitchenDataContext } from '../context/KitchenDataContext';
import type { RiskEvent } from '@/lib/planning/risk-events';

interface BatchCardProps {
  intermediateKey: string; // assemblyId -- key into intermediates map
  /** For scheduled (calendar) cards, pass the batch ID + quantity */
  batchId?: string;
  batchQuantity?: number;
  deadline?: string;
  variant?: 'sidebar' | 'calendar';
  feasibilityColor?: 'green' | 'amber' | 'red';
  warnings?: string[];
  /** True if this batch was auto-placed from an existing Unleashed assembly */
  isUnleashed?: boolean;
  /** Active risk event affecting this batch (worsened feasibility). */
  riskEvent?: RiskEvent;
  onDragStart?: (key: string) => void;
  onClick?: () => void;
}

/** Inline editable kg badge */
function EditableQty({
  value,
  onCommit,
  className,
}: {
  value: number;
  onCommit: (v: number) => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(String(value));
      // defer focus so React has rendered
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [editing, value]);

  const commit = () => {
    const parsed = parseFloat(draft);
    if (!isNaN(parsed) && parsed > 0 && parsed !== value) {
      onCommit(parsed);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="number"
        step="any"
        min="0.1"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(false);
        }}
        onClick={(e) => e.stopPropagation()}
        className="w-16 px-1 py-0.5 rounded text-xs text-right focus:outline-none"
        style={{
          fontWeight: 500,
          color: 'var(--text-primary)',
          background: 'var(--bg-page)',
          border: '0.5px solid var(--accent)',
        }}
      />
    );
  }

  return (
    <span
      className={`cursor-text rounded transition hover:opacity-70 ${className || ''}`}
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      title="Click to edit quantity"
      style={{ borderBottom: '0.5px dashed var(--border)' }}
    >
      {value}kg
    </span>
  );
}

export function BatchCard({
  intermediateKey,
  batchId,
  batchQuantity,
  deadline,
  variant = 'sidebar',
  feasibilityColor = 'green',
  warnings = [],
  isUnleashed = false,
  riskEvent,
  onDragStart,
  onClick,
}: BatchCardProps) {
  const { intermediates, updateBatchQuantity, updateIntermediateBatchSize } =
    useKitchenDataContext();
  const intermediate = intermediates[intermediateKey];
  if (!intermediate) return null;

  const equipmentColor =
    EQUIPMENT_COLORS[intermediate.equipment as keyof typeof EQUIPMENT_COLORS];

  const displayQty = batchQuantity ?? intermediate.batchSize;

  const handleQtyChange = (newQty: number) => {
    if (variant === 'calendar' && batchId && updateBatchQuantity) {
      updateBatchQuantity(batchId, newQty);
    } else if (updateIntermediateBatchSize) {
      updateIntermediateBatchSize(intermediateKey, newQty);
    }
  };

  const FEASIBILITY_MAP = {
    green: { bg: 'var(--success-light)', border: 'var(--success)' },
    amber: { bg: 'var(--warning-light)', border: 'var(--warning)' },
    red: { bg: 'var(--danger-light)', border: 'var(--danger)' },
  };

  const colors = FEASIBILITY_MAP[feasibilityColor];
  const warningText = warnings.length > 0 ? warnings.join('\n') : undefined;

  if (variant === 'calendar') {
    return (
      <div
        className="p-2 rounded text-xs cursor-pointer hover:opacity-80 transition"
        style={{
          background: colors.bg,
          borderTopWidth: isUnleashed ? '0.5px' : 0,
          borderRightWidth: isUnleashed ? '0.5px' : 0,
          borderBottomWidth: isUnleashed ? '0.5px' : 0,
          borderLeftWidth: '3px',
          borderTopStyle: 'solid',
          borderRightStyle: 'solid',
          borderBottomStyle: 'solid',
          borderLeftStyle: 'solid',
          borderTopColor: isUnleashed ? 'var(--accent)' : 'transparent',
          borderRightColor: isUnleashed ? 'var(--accent)' : 'transparent',
          borderBottomColor: isUnleashed ? 'var(--accent)' : 'transparent',
          borderLeftColor: colors.border,
        }}
        onClick={onClick}
        title={warningText}
      >
        <div className="flex items-center justify-between gap-1">
          <div className="truncate" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
            {intermediate.code}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {isUnleashed && (
              <span
                className="text-[9px] px-1 py-0.5 rounded leading-none"
                style={{ fontWeight: 500, background: 'var(--accent-light)', color: 'var(--accent)' }}
              >
                UNL
              </span>
            )}
            {riskEvent && (
              <span
                className="text-xs cursor-help"
                title={riskEvent.description}
                style={{ color: 'var(--warning)' }}
              >
                {'\u26A0'}
              </span>
            )}
            {warnings.length > 0 && !riskEvent && (
              <span className="text-xs">
                {feasibilityColor === 'red' ? '!' : '!'}
              </span>
            )}
          </div>
        </div>
        <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          <EditableQty value={displayQty} onCommit={handleQtyChange} />
        </div>
        <div className="flex items-center gap-1 mt-1">
          <div
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: equipmentColor.bg }}
            title={equipmentColor.name}
          />
          {intermediate.assemblyNumber && (
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              {intermediate.assemblyNumber}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart?.(intermediateKey);
      }}
      onClick={onClick}
      className="rounded p-3 cursor-grab active:cursor-grabbing transition hover:opacity-80"
      style={{
        background: 'var(--bg-surface)',
        border: '0.5px solid var(--border)',
      }}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex-1">
          <div className="text-sm" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
            {intermediate.name}
          </div>
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{intermediate.code}</div>
        </div>
        <span
          className="inline-block px-2 py-1 rounded text-xs"
          style={{ fontWeight: 500, background: 'var(--bg-hover)', color: 'var(--text-primary)' }}
        >
          <EditableQty value={displayQty} onCommit={handleQtyChange} />
        </span>
      </div>

      {intermediate.assemblyNumber && (
        <div className="text-xs mb-2 font-mono" style={{ color: 'var(--text-muted)' }}>
          {intermediate.assemblyNumber}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: equipmentColor.bg }}
            title={equipmentColor.name}
          />
          {intermediate.createdOn && (
            <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              {new Date(intermediate.createdOn).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}
            </div>
          )}
        </div>
        {deadline && (
          <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            Due: {new Date(deadline).toLocaleDateString('en-AU')}
          </div>
        )}
      </div>
    </div>
  );
}
