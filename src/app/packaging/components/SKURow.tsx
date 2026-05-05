'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import type { PackagingSKU } from '../hooks/usePackagingData';
import { formatDayInt, dateToDayInt } from '@/lib/planning/working-day';
import {
  useCellNavigation,
  type CellCoord,
} from '../context/CellNavigationContext';

interface SKURowProps {
  sku: PackagingSKU;
  planned: { quantity: number; dayInt: number } | null;
  existingQtyEdit: number | null;
  existingDayEdit: number | null;
  onSetQty: (productCode: string, qty: number) => void;
  onSetDay: (productCode: string, dayInt: number) => void;
  onSetExistingQty: (productCode: string, qty: number) => void;
  onSetExistingDay: (productCode: string, dayInt: number) => void;
  onFillSuggestion: (productCode: string) => void;
  onSetUsage: (productCode: string, usage: number) => void;
  /**
   * Optional click callback for opening the BOM investigation modal. The SKU
   * code cell becomes clickable when this is provided; editable cells keep
   * their own click behaviour.
   */
  onOpenModal?: (productCode: string) => void;
  familyCode: string;
  rowIndex: number;
}

function daysColor(days: number): string {
  if (days === Infinity) return 'var(--text-muted)';
  if (days < 14) return 'var(--danger)';
  if (days < 30) return 'var(--warning)';
  return 'var(--text-secondary)';
}

function coordsEqual(a: CellCoord | null, b: CellCoord): boolean {
  return (
    a !== null &&
    a.familyCode === b.familyCode &&
    a.rowIndex === b.rowIndex &&
    a.colIndex === b.colIndex
  );
}

/** Inline editable number cell with spreadsheet navigation */
export function EditableCell({
  value,
  onCommit,
  placeholder,
  className,
  tooltip,
  coord,
}: {
  value: number | null;
  onCommit: (v: number) => void;
  placeholder?: string;
  className?: string;
  tooltip?: string;
  coord: CellCoord;
}) {
  const { activeCell, setActiveCell, moveToNext } = useCellNavigation();
  const isEditing = coordsEqual(activeCell, coord);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      setDraft(value != null && value > 0 ? String(value) : '');
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [isEditing, value]);

  const commit = useCallback(() => {
    if (draft.trim() === '') { onCommit(0); return; }
    const parsed = parseFloat(draft);
    if (!isNaN(parsed) && parsed >= 0) onCommit(parsed);
  }, [draft, onCommit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); moveToNext(coord, 'down'); }
      else if (e.key === 'Tab') { e.preventDefault(); commit(); moveToNext(coord, e.shiftKey ? 'left' : 'right'); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); commit(); moveToNext(coord, 'down'); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); commit(); moveToNext(coord, 'up'); }
      else if (e.key === 'ArrowLeft') {
        const el = e.currentTarget;
        if (el.selectionStart === 0 && el.selectionEnd === 0) {
          e.preventDefault(); commit(); moveToNext(coord, 'left');
        }
      }
      else if (e.key === 'ArrowRight') {
        const el = e.currentTarget;
        if (el.selectionStart === el.value.length) {
          e.preventDefault(); commit(); moveToNext(coord, 'right');
        }
      }
      else if (e.key === 'Escape') { setActiveCell(null); }
    },
    [commit, coord, moveToNext, setActiveCell]
  );

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        type="number"
        step="any"
        min="0"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          commit();
          requestAnimationFrame(() => setActiveCell(null));
        }}
        onKeyDown={handleKeyDown}
        className="w-full px-1.5 py-0.5 rounded font-mono text-sm text-right focus:outline-none"
        style={{
          display: 'block',
          boxSizing: 'border-box',
          color: 'var(--text-primary)',
          background: 'var(--bg-page)',
          border: '0.5px solid var(--accent)',
        }}
      />
    );
  }

  return (
    <span
      className={`block w-full cursor-text rounded px-1.5 py-0.5 text-right transition font-mono text-sm hover:opacity-70 ${className || ''}`}
      onClick={() => setActiveCell(coord)}
      title={tooltip || 'Click to edit'}
      style={{
        boxSizing: 'border-box',
        border: '0.5px solid transparent',
        borderBottom: '0.5px dashed var(--border)',
      }}
    >
      {value != null && value > 0 ? value : placeholder || '—'}
    </span>
  );
}

export function SKURow({
  sku,
  planned,
  existingQtyEdit,
  existingDayEdit,
  onSetQty,
  onSetDay,
  onSetExistingQty,
  onSetExistingDay,
  onFillSuggestion,
  onSetUsage,
  onOpenModal,
  familyCode,
  rowIndex,
}: SKURowProps) {
  const plannedQty = planned?.quantity ?? 0;
  const plannedDay = planned?.dayInt ?? 0;
  const existingOrigDayInt = sku.existingAssemblyDate
    ? dateToDayInt(new Date(sku.existingAssemblyDate), undefined, { weekend: 'up' })
    : 0;
  const labelWarning = plannedQty > 0 && sku.labelsOnHand < plannedQty;

  return (
    <tr
      className="transition text-sm"
      style={{ borderBottom: '0.5px solid var(--border)' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-surface)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
    >
      {/* SKU — click to open BOM investigation modal */}
      <td
        className="px-2 py-1.5 font-mono truncate max-w-[120px]"
        style={{
          color: onOpenModal ? 'var(--accent)' : 'var(--text-primary)',
          cursor: onOpenModal ? 'pointer' : undefined,
          textDecoration: onOpenModal ? 'underline' : undefined,
          textDecorationStyle: 'dotted',
          textUnderlineOffset: 2,
        }}
        title={onOpenModal ? `${sku.productName} — click to view BOM & drafts` : sku.productName}
        onClick={onOpenModal ? () => onOpenModal(sku.productCode) : undefined}
      >
        {sku.productCode}
      </td>

      {/* Size */}
      <td className="px-2 py-1.5 text-center">
        <span
          className="inline-block px-1.5 py-0.5 rounded text-xs"
          style={{ fontWeight: 500, color: 'var(--text-secondary)', background: 'var(--bg-surface)' }}
        >
          {sku.sizeVariant || '—'}
        </span>
      </td>

      {/* Days Available */}
      <td className="px-2 py-1.5 text-right font-mono" style={{
        color: daysColor(sku.daysAvailable),
        fontWeight: sku.daysAvailable < 14 ? 500 : 400,
        background: sku.daysAvailable === Infinity ? 'rgba(21, 128, 61, 0.06)'
          : sku.daysAvailable <= 0 ? 'rgba(185, 28, 28, 0.22)'
          : sku.daysAvailable < 7 ? 'rgba(185, 28, 28, 0.14)'
          : sku.daysAvailable < 14 ? 'rgba(180, 83, 9, 0.12)'
          : sku.daysAvailable < 30 ? 'rgba(180, 83, 9, 0.05)'
          : sku.daysAvailable >= 60 ? 'rgba(21, 128, 61, 0.06)'
          : undefined,
      }}>
        {sku.daysAvailable === Infinity ? '∞' : Math.round(sku.daysAvailable)}
      </td>

      {/* Monthly Usage (read-only) */}
      <td className="px-2 py-1.5 text-right font-mono" style={{
        color: 'var(--text-secondary)',
        background: (sku.monthlyUsage ?? 0) >= 1000 ? 'rgba(37, 99, 235, 0.18)'
          : (sku.monthlyUsage ?? 0) >= 500 ? 'rgba(37, 99, 235, 0.13)'
          : (sku.monthlyUsage ?? 0) >= 100 ? 'rgba(37, 99, 235, 0.08)'
          : (sku.monthlyUsage ?? 0) > 0 ? 'rgba(37, 99, 235, 0.04)'
          : undefined,
      }}>
        {sku.monthlyUsage != null && sku.monthlyUsage > 0 ? sku.monthlyUsage.toLocaleString() : '—'}
      </td>

      {/* FG SOH */}
      <td className="px-2 py-1.5 text-right font-mono" style={{
        color: 'var(--text-primary)',
        background: sku.daysAvailable !== Infinity && sku.daysAvailable <= 0 ? 'rgba(185, 28, 28, 0.12)'
          : sku.daysAvailable !== Infinity && sku.daysAvailable < 7 ? 'rgba(185, 28, 28, 0.08)'
          : sku.daysAvailable !== Infinity && sku.daysAvailable < 14 ? 'rgba(180, 83, 9, 0.06)'
          : undefined,
      }}>
        {sku.fgSOH}
      </td>

      {/* Available Stock (all warehouses) */}
      <td className="px-2 py-1.5 text-right font-mono" style={{
        color: sku.availableStock !== sku.fgSOH ? 'var(--accent)' : 'var(--text-muted)',
      }}>
        {sku.availableStock}
      </td>

      {/* ── Existing group (tinted background + left border on first) ── */}

      {/* Existing Qty — col 0 */}
      <td className="px-2 py-1.5 text-right" style={{
        color: existingQtyEdit != null && existingQtyEdit !== sku.existingAssemblyQty
          ? 'var(--warning)' : 'var(--accent)',
        fontWeight: 500,
        background: 'var(--bg-surface)',
        borderLeft: '2px solid var(--border)',
      }}>
        {sku.existingAssemblyQty ? (
          <EditableCell
            value={existingQtyEdit ?? sku.existingAssemblyQty}
            onCommit={(v) => onSetExistingQty(sku.productCode, Math.round(v))}
            placeholder="—"
            tooltip={`${sku.existingAssemblyNumber || 'Open assembly'} — edit to update qty`}
            coord={{ familyCode, rowIndex, colIndex: 0 }}
          />
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>—</span>
        )}
      </td>

      {/* Existing Day — col 1 */}
      <td className="px-2 py-1.5 text-right" style={{
        color: 'var(--text-primary)',
        background: 'var(--bg-surface)',
      }}>
        {sku.existingAssemblyQty ? (
          <>
            <EditableCell
              value={(existingDayEdit ?? existingOrigDayInt) || null}
              onCommit={(v) => onSetExistingDay(sku.productCode, Math.round(v))}
              placeholder="-"
              tooltip={
                (existingDayEdit ?? existingOrigDayInt) > 0
                  ? formatDayInt(existingDayEdit ?? existingOrigDayInt)
                  : 'Enter working day (1-5 = this week)'
              }
              coord={{ familyCode, rowIndex, colIndex: 1 }}
            />
            <div className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)', minHeight: '1em' }}>
              {(existingDayEdit ?? existingOrigDayInt) > 0
                ? formatDayInt(existingDayEdit ?? existingOrigDayInt)
                : '\u00A0'}
            </div>
          </>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>—</span>
        )}
      </td>

      {/* Suggested */}
      <td className="px-2 py-1.5 text-right">
        {sku.suggestedQty > 0 ? (
          <button
            onClick={() => onFillSuggestion(sku.productCode)}
            className="font-mono transition hover:opacity-70"
            style={{ color: 'var(--accent)', fontWeight: 500 }}
            title="Click to fill planned quantity"
          >
            {sku.suggestedQty}
          </button>
        ) : (
          <span className="font-mono" style={{ color: 'var(--text-muted)' }}>{'—'}</span>
        )}
      </td>

      {/* ── Plan group (tinted background + left border on first) ── */}

      {/* Planned Qty — col 2 */}
      <td className="px-2 py-1.5 text-right" style={{
        color: 'var(--text-primary)',
        background: 'var(--bg-surface)',
        borderLeft: '2px solid var(--border)',
      }}>
        <EditableCell
          value={plannedQty || null}
          onCommit={(v) => onSetQty(sku.productCode, Math.round(v))}
          placeholder="-"
          coord={{ familyCode, rowIndex, colIndex: 2 }}
        />
      </td>

      {/* Planned Day — col 3 */}
      <td className="px-2 py-1.5 text-right" style={{
        color: 'var(--text-primary)',
        background: 'var(--bg-surface)',
      }}>
        <EditableCell
          value={plannedDay || null}
          onCommit={(v) => onSetDay(sku.productCode, Math.round(v))}
          placeholder="-"
          tooltip={plannedDay > 0 ? formatDayInt(plannedDay) : 'Enter working day (1-5 = this week)'}
          coord={{ familyCode, rowIndex, colIndex: 3 }}
        />
        <div className="text-[13px] mt-0.5" style={{ color: 'var(--text-muted)', minHeight: '1em' }}>
          {plannedDay > 0 ? formatDayInt(plannedDay) : '\u00A0'}
        </div>
      </td>

      {/* Limit — componentSOH / kgPerUnit */}
      <td className="px-2 py-1.5 text-right font-mono" style={{
        color: sku.canAssemble > 0 ? 'var(--text-secondary)' : 'var(--text-muted)',
        background: sku.canAssemble <= 0 && (sku.monthlyUsage ?? 0) > 0 ? 'rgba(185, 28, 28, 0.10)'
          : plannedQty > 0 && sku.canAssemble > 0 && sku.canAssemble < plannedQty ? 'rgba(180, 83, 9, 0.10)'
          : undefined,
      }}>
        {Math.floor(sku.canAssemble).toLocaleString()}
      </td>

      {/* Labels */}
      <td className="px-2 py-1.5 text-right font-mono" style={{ color: labelWarning ? 'var(--danger)' : 'var(--text-muted)', fontWeight: labelWarning ? 500 : 400 }}>
        {sku.labelsOnHand}
        {labelWarning && <span className="ml-1">!</span>}
      </td>
    </tr>
  );
}
