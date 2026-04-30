'use client';

import { useState } from 'react';
import type { DraftPO } from '../hooks/usePurchasingPlanner';

interface DraftPOModalProps {
  componentCode: string;
  componentName: string;
  supplierId: string;
  supplierName: string;
  prefilledDate: Date;
  recommendedQuantity: number;
  recommendedDate: Date | null;
  existingDrafts: DraftPO[];
  onAdd: (draft: Omit<DraftPO, 'id'>) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}

export function DraftPOModal({
  componentCode,
  componentName,
  supplierId,
  supplierName,
  prefilledDate,
  recommendedQuantity,
  recommendedDate,
  existingDrafts,
  onAdd,
  onRemove,
  onClose,
}: DraftPOModalProps) {
  const [deliveryDate, setDeliveryDate] = useState(
    prefilledDate.toISOString().split('T')[0]
  );
  const [quantity, setQuantity] = useState(
    recommendedQuantity > 0 ? Math.round(recommendedQuantity) : 500
  );

  const handleSubmit = () => {
    if (quantity <= 0) return;
    onAdd({
      componentCode,
      componentName,
      supplierId,
      supplierName,
      deliveryDate: new Date(deliveryDate),
      quantity,
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="rounded-lg max-w-md w-full p-6"
        style={{ background: 'var(--bg-page)', border: '0.5px solid var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg mb-4" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
          Add Draft PO
        </h2>

        <div className="space-y-4">
          {/* Component info */}
          <div className="rounded p-3 text-sm" style={{ background: 'var(--bg-surface)' }}>
            <div className="flex justify-between" style={{ color: 'var(--text-secondary)' }}>
              <span>Component</span>
              <span style={{ color: 'var(--text-primary)' }}>{componentName}</span>
            </div>
            <div className="flex justify-between mt-1" style={{ color: 'var(--text-secondary)' }}>
              <span>Supplier</span>
              <span style={{ color: 'var(--text-primary)' }}>{supplierName || 'Unassigned'}</span>
            </div>
          </div>

          {/* Engine recommendation */}
          {recommendedQuantity > 0 && recommendedDate && (
            <div
              className="rounded p-3 text-sm"
              style={{ background: 'var(--accent-light)', color: 'var(--accent)', border: '0.5px solid var(--accent)' }}
            >
              Suggested: <span style={{ fontWeight: 500 }}>{Math.round(recommendedQuantity)}</span> units
              by{' '}
              <span style={{ fontWeight: 500 }}>
                {recommendedDate.toLocaleDateString('en-AU', {
                  day: 'numeric',
                  month: 'short',
                })}
              </span>
            </div>
          )}

          {/* Delivery date */}
          <div>
            <label className="block text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>
              Delivery Date
            </label>
            <input
              type="date"
              value={deliveryDate}
              onChange={(e) => setDeliveryDate(e.target.value)}
              className="w-full rounded px-3 py-2 text-sm focus:outline-none transition"
              style={{
                color: 'var(--text-primary)',
                background: 'var(--bg-surface)',
                border: '0.5px solid var(--border)',
              }}
            />
          </div>

          {/* Quantity */}
          <div>
            <label className="block text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>
              Quantity (kg)
            </label>
            <input
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))}
              className="w-full rounded px-3 py-2 text-sm focus:outline-none transition"
              style={{
                color: 'var(--text-primary)',
                background: 'var(--bg-surface)',
                border: '0.5px solid var(--border)',
              }}
            />
          </div>

          {/* Existing drafts for this component */}
          {existingDrafts.length > 0 && (
            <div>
              <div className="text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>
                Existing draft POs for {componentCode}:
              </div>
              <div className="space-y-1">
                {existingDrafts.map((d) => (
                  <div
                    key={d.id}
                    className="flex items-center justify-between rounded px-3 py-1.5 text-xs"
                    style={{ background: 'var(--bg-surface)' }}
                  >
                    <span style={{ color: 'var(--text-primary)' }}>
                      {Math.round(d.quantity)}kg on{' '}
                      {d.deliveryDate.toLocaleDateString('en-AU', {
                        day: 'numeric',
                        month: 'short',
                      })}
                    </span>
                    <button
                      onClick={() => onRemove(d.id)}
                      className="transition hover:opacity-70"
                      style={{ color: 'var(--danger)' }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Buttons */}
        <div className="flex justify-end gap-3 mt-6">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded text-sm transition hover:opacity-80"
            style={{ color: 'var(--text-secondary)', border: '0.5px solid var(--border)', fontWeight: 400 }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={quantity <= 0}
            className="px-3 py-1.5 rounded text-sm text-white transition disabled:opacity-30 disabled:cursor-not-allowed"
            style={{ background: 'var(--accent)', fontWeight: 500 }}
          >
            Add PO
          </button>
        </div>
      </div>
    </div>
  );
}
