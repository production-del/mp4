'use client';

/**
 * Packaging card BOM modal.
 *
 * Opened when an operator clicks a card on the packaging calendar. Shows the
 * full BOM for the packaging run (the FG's direct components: label +
 * intermediate + any other lines from Unleashed), with SOH at MF Packaging
 * and globally so shortfalls are obvious at a glance. Each component has
 * inline "+ PO" and "+ Transfer" actions that write to the same draft stores
 * used by the purchasing and logistics pages — so a draft created here shows
 * up wherever else the operator expects it.
 *
 * A family toggle lets the operator peek at sibling SKUs (e.g., all three
 * sizes of Walnuts Activated) without closing the modal — useful when a
 * shortage on IAW spans multiple runs and you want to size a single PO to
 * cover them all.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PackagingSKU, SupplierRef } from '../hooks/usePackagingData';
import type { PackingTeam } from '../hooks/usePackagingPlanner';
import { TEAM_LABELS, TEAM_COLORS } from '../hooks/usePackagingPlanner';
import { WarehouseSOH } from '@/lib/planning/warehouse-soh';
import { WAREHOUSES } from '@/lib/planning/warehouse-assignments';

/**
 * Build the dropdown option list for the "from warehouse" field. Starts from
 * the canonical warehouse constants (excluding MF Packaging — that's always
 * the destination) and adds any additional warehouse names the SOH snapshot
 * mentions so custom or newly-added Unleashed warehouses appear without a
 * code change.
 */
function buildFromWarehouseOptions(sohItems: RawSOHItem[]): string[] {
  const seen = new Set<string>();
  const options: string[] = [];
  const pushIfNew = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === WAREHOUSES.MF_PACKAGING || seen.has(trimmed)) return;
    seen.add(trimmed);
    options.push(trimmed);
  };
  for (const wh of Object.values(WAREHOUSES)) pushIfNew(wh);
  for (const s of sohItems) {
    if (s.warehouseName) pushIfNew(s.warehouseName);
  }
  return options;
}
import {
  listByKind,
  replaceByKind,
} from '@/lib/planning/plan-draft-store';
import {
  loadDraftTransfers,
  saveDraftTransfers,
} from '@/lib/planning/transfer-store';
import type { PurchaseOrderItem } from '@/lib/planning/plan-item';
import type { DraftTransfer } from '@/lib/planning/transfer-types';
import { dayIntToDate, formatDayInt, toLocalISODate } from '@/lib/planning/working-day';
import type { StockOnHandItem } from '@/lib/unleashed/types';

interface RawBOMEntry {
  productCode: string;
  productDescription: string;
  quantityPerParent: number;
  parentProductCode: string;
}

interface RawSOHItem {
  productCode: string;
  productName: string;
  warehouseId?: string;
  warehouseName?: string;
  quantity: number;
  availableQty?: number;
}

interface PackagingCardModalProps {
  /** The FG product code for the card that was clicked. */
  productCode: string;
  /** Optional scheduled-run context so the modal can compute exact demand. */
  runQuantity?: number;
  runDayInt?: number;
  runTeam?: PackingTeam;
  skus: PackagingSKU[];
  bomEntries: RawBOMEntry[];
  sohItems: RawSOHItem[];
  supplierByCode: Record<string, SupplierRef>;
  onClose: () => void;
}

interface ComponentRow {
  code: string;
  name: string;
  kind: 'label' | 'intermediate' | 'other';
  /** Demand in this run's natural unit (kg for intermediates, units for labels/other). */
  required: number;
  unit: 'kg' | 'ea';
  sohAtPackaging: number;
  sohGlobal: number;
  supplier?: SupplierRef;
}

function classifyComponent(code: string, productGroups: Map<string, string>): ComponentRow['kind'] {
  if (code.startsWith('L') && !code.startsWith('LI')) return 'label';
  const group = productGroups.get(code);
  if (group === 'MF - Intermediate') return 'intermediate';
  const INTERMEDIATE_PREFIXES = ['IA', 'IG', 'IM', 'IC', 'IS', 'IY'];
  if (INTERMEDIATE_PREFIXES.some(p => code.startsWith(p))) return 'intermediate';
  return 'other';
}

/**
 * Build the per-component demand rows for one FG run. Prefers real BOM
 * entries when available; falls back to SKU-level label + intermediate when
 * the BOM hasn't been cached for that parent.
 */
function buildRows(
  sku: PackagingSKU,
  runQuantity: number,
  bomByParent: Map<string, RawBOMEntry[]>,
  sohView: WarehouseSOH,
  globalSOH: Record<string, number>,
  packagingSOH: Record<string, number>,
  supplierByCode: Record<string, SupplierRef>,
  productGroups: Map<string, string>,
  nameByCode: Map<string, string>,
): ComponentRow[] {
  const rows: ComponentRow[] = [];
  const bomLines = bomByParent.get(sku.productCode) || [];

  const pushRow = (
    code: string,
    name: string,
    kind: ComponentRow['kind'],
    required: number,
    unit: ComponentRow['unit'],
  ) => {
    if (required <= 0) return;
    rows.push({
      code,
      name,
      kind,
      required,
      unit,
      sohAtPackaging: packagingSOH[code] || 0,
      sohGlobal: globalSOH[code] || 0,
      supplier: supplierByCode[code],
    });
  };

  if (bomLines.length === 0) {
    if (sku.labelSKU) {
      pushRow(sku.labelSKU, nameByCode.get(sku.labelSKU) || sku.labelSKU, 'label', runQuantity, 'ea');
    }
    if (sku.foodComponentCode && sku.kgPerUnit > 0) {
      pushRow(
        sku.foodComponentCode,
        nameByCode.get(sku.foodComponentCode) || sku.foodComponentCode,
        'intermediate',
        runQuantity * sku.kgPerUnit,
        'kg',
      );
    }
    return rows;
  }

  for (const line of bomLines) {
    const kind = classifyComponent(line.productCode, productGroups);
    const unit: ComponentRow['unit'] = kind === 'label' || kind === 'other' ? 'ea' : 'kg';
    const required =
      kind === 'label'
        ? runQuantity // labels are 1:1 per unit regardless of BOM value
        : runQuantity * (line.quantityPerParent || 0);
    pushRow(
      line.productCode,
      nameByCode.get(line.productCode) || line.productDescription || line.productCode,
      kind,
      required,
      unit,
    );
  }
  void sohView;
  return rows;
}

function round(n: number, places = 3): number {
  const k = Math.pow(10, places);
  return Math.round(n * k) / k;
}

// ─── Component ──────────────────────────────────────────────

export function PackagingCardModal({
  productCode,
  runQuantity,
  runDayInt,
  runTeam,
  skus,
  bomEntries,
  sohItems,
  supplierByCode,
  onClose,
}: PackagingCardModalProps) {
  const sku = useMemo(
    () => skus.find(s => s.productCode === productCode) || null,
    [skus, productCode],
  );

  const [showFamily, setShowFamily] = useState(false);
  const [draftFor, setDraftFor] = useState<{ kind: 'po' | 'transfer'; row: ComponentRow } | null>(null);
  const [poSupplier, setPoSupplier] = useState('');
  const [poDate, setPoDate] = useState('');
  const [poQty, setPoQty] = useState('');
  const [txDate, setTxDate] = useState('');
  const [txQty, setTxQty] = useState('');
  const [txFrom, setTxFrom] = useState('');
  const [flash, setFlash] = useState<string | null>(null);

  // Rebuild/seed the inline form when the operator chooses a component.
  useEffect(() => {
    if (!draftFor) return;
    const { row, kind } = draftFor;
    // Prefill with sensible defaults so the form is usable in one tab.
    if (kind === 'po') {
      const twoWeeks = new Date();
      twoWeeks.setDate(twoWeeks.getDate() + 14);
      setPoDate(toLocalISODate(twoWeeks));
      const shortfall = Math.max(0, row.required - row.sohGlobal);
      setPoQty(String(Math.ceil(shortfall > 0 ? shortfall : row.required)));
      setPoSupplier(row.supplier?.name || '');
    } else {
      // transfer
      const needBy = runDayInt ? dayIntToDate(runDayInt) : new Date();
      setTxDate(toLocalISODate(needBy));
      const transferable = Math.max(0, Math.min(row.required - row.sohAtPackaging, row.sohGlobal - row.sohAtPackaging));
      setTxQty(String(Math.ceil(transferable > 0 ? transferable : row.required - row.sohAtPackaging)));
      // Guess the from-warehouse: pick the one holding the most.
      const perWh = new WarehouseSOH(sohItems as unknown as StockOnHandItem[]).perProductMap()[row.code] || {};
      const best = Object.entries(perWh)
        .filter(([wh]) => wh !== WAREHOUSES.MF_PACKAGING)
        .sort((a, b) => b[1] - a[1])[0];
      setTxFrom(best ? best[0] : '');
    }
  }, [draftFor, runDayInt, sohItems]);

  if (!sku) return null;

  // Build the SOH view and demand rows once per open modal.
  const sohView = new WarehouseSOH(sohItems as unknown as StockOnHandItem[]);
  const globalSOH = sohView.globalOnHandMap();
  const packagingSOH = sohView.byWarehouseMap(WAREHOUSES.MF_PACKAGING);

  const bomByParent = new Map<string, RawBOMEntry[]>();
  for (const e of bomEntries) {
    if (!bomByParent.has(e.parentProductCode)) bomByParent.set(e.parentProductCode, []);
    bomByParent.get(e.parentProductCode)!.push(e);
  }

  const productGroups = new Map<string, string>();
  for (const s of skus) productGroups.set(s.productCode, s.productGroup);

  const nameByCode = new Map<string, string>();
  for (const s of skus) nameByCode.set(s.productCode, s.productName);
  for (const e of bomEntries) {
    if (!nameByCode.has(e.productCode)) nameByCode.set(e.productCode, e.productDescription);
  }
  for (const s of sohItems) {
    if (!nameByCode.has(s.productCode)) nameByCode.set(s.productCode, s.productName);
  }

  const effectiveQty = runQuantity ?? sku.suggestedQty;
  const mainRows = buildRows(
    sku,
    effectiveQty,
    bomByParent,
    sohView,
    globalSOH,
    packagingSOH,
    supplierByCode,
    productGroups,
    nameByCode,
  );

  // Siblings = other SKUs in the same family, excluding this one.
  const familySiblings = showFamily
    ? skus.filter(s => s.familyCode === sku.familyCode && s.productCode !== sku.productCode)
    : [];

  const savePO = useCallback(() => {
    if (!draftFor) return;
    const existing = listByKind('purchase_order');
    const newId = `pkg-draft-po-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const item: PurchaseOrderItem = {
      kind: 'purchase_order',
      id: newId,
      productCode: draftFor.row.code,
      productName: draftFor.row.name,
      quantity: Number(poQty) || 0,
      lifecycle: 'draft',
      deliveryDate: poDate,
      supplierId: '',
      supplierName: poSupplier,
    };
    replaceByKind('purchase_order', [...existing, item]);
    setFlash('Draft PO saved');
    setTimeout(() => setFlash(null), 2000);
    setDraftFor(null);
  }, [draftFor, poQty, poDate, poSupplier]);

  const saveTransfer = useCallback(() => {
    if (!draftFor) return;
    const existing = loadDraftTransfers();
    const date = new Date(txDate);
    const newTx: DraftTransfer = {
      id: `pkg-transfer-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      productCode: draftFor.row.code,
      productName: draftFor.row.name,
      quantity: Number(txQty) || 0,
      fromWarehouse: txFrom,
      toWarehouse: WAREHOUSES.MF_PACKAGING,
      transferDate: date,
      needByDate: date,
      status: 'draft',
      reason: 'Packaging run requirement',
    };
    saveDraftTransfers([...existing, newTx]);
    setFlash('Draft transfer saved');
    setTimeout(() => setFlash(null), 2000);
    setDraftFor(null);
  }, [draftFor, txDate, txQty, txFrom]);

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="rounded-lg max-w-3xl w-full max-h-[90vh] overflow-y-auto"
        style={{ background: 'var(--bg-page)', border: '0.5px solid var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="sticky top-0 px-6 py-4 flex items-center justify-between"
          style={{ background: 'var(--bg-page)', borderBottom: '0.5px solid var(--border)' }}
        >
          <div>
            <h2 className="text-lg" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
              {sku.productName}
            </h2>
            <div className="flex items-center gap-3 mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              <span style={{ fontFamily: 'monospace' }}>{sku.productCode}</span>
              <span>{effectiveQty.toLocaleString()} units</span>
              {runDayInt ? <span>{formatDayInt(runDayInt)}</span> : null}
              {runTeam ? (
                <span className="flex items-center gap-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: TEAM_COLORS[runTeam] }} />
                  {TEAM_LABELS[runTeam]}
                </span>
              ) : null}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-2xl transition hover:opacity-60"
            style={{ color: 'var(--text-muted)' }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-6">
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 style={{ fontWeight: 500, color: 'var(--text-primary)' }}>BOM required</h3>
              {flash && (
                <span className="text-xs" style={{ color: 'var(--success)', fontWeight: 500 }}>{flash}</span>
              )}
            </div>
            <ComponentTable
              rows={mainRows}
              onDraftPO={(row) => setDraftFor({ kind: 'po', row })}
              onDraftTransfer={(row) => setDraftFor({ kind: 'transfer', row })}
            />
          </section>

          {/* Inline draft forms */}
          {draftFor?.kind === 'po' && (
            <section
              className="rounded-lg p-4 space-y-3"
              style={{ background: 'var(--accent-light)', border: '0.5px solid var(--accent)' }}
            >
              <div className="text-xs" style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>
                Draft PO for <span style={{ color: 'var(--text-primary)' }}>{draftFor.row.name}</span>
                {' '}({draftFor.row.code})
              </div>
              <div className="grid grid-cols-3 gap-3">
                <LabeledInput label="Supplier" value={poSupplier} onChange={setPoSupplier} />
                <LabeledInput label="Delivery date" type="date" value={poDate} onChange={setPoDate} />
                <LabeledInput label={`Qty (${draftFor.row.unit})`} value={poQty} onChange={setPoQty} />
              </div>
              <FormActions onSave={savePO} onCancel={() => setDraftFor(null)} saveLabel="Save draft PO" />
            </section>
          )}
          {draftFor?.kind === 'transfer' && (
            <section
              className="rounded-lg p-4 space-y-3"
              style={{ background: 'var(--warning-light)', border: '0.5px solid var(--warning)' }}
            >
              <div className="text-xs" style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>
                Draft transfer for <span style={{ color: 'var(--text-primary)' }}>{draftFor.row.name}</span>
                {' '}({draftFor.row.code})
                {' '}<span style={{ color: 'var(--text-muted)' }}>
                  → {WAREHOUSES.MF_PACKAGING}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <LabeledSelect
                  label="From warehouse"
                  value={txFrom}
                  onChange={setTxFrom}
                  options={buildFromWarehouseOptions(sohItems)}
                  placeholder="Select warehouse…"
                />
                <LabeledInput label="Transfer date" type="date" value={txDate} onChange={setTxDate} />
                <LabeledInput label={`Qty (${draftFor.row.unit})`} value={txQty} onChange={setTxQty} />
              </div>
              <FormActions onSave={saveTransfer} onCancel={() => setDraftFor(null)} saveLabel="Save draft transfer" accent="warning" />
            </section>
          )}

          {/* Family toggle + siblings */}
          <section>
            <button
              onClick={() => setShowFamily(v => !v)}
              className="text-xs transition hover:opacity-80"
              style={{ color: 'var(--text-secondary)', textDecoration: 'underline' }}
            >
              {showFamily ? 'Hide other SKUs in this family' : `Show other SKUs in ${sku.familyName} (${familySiblings.length})`}
            </button>
            {showFamily && familySiblings.length === 0 && (
              <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                No other SKUs in this family.
              </p>
            )}
            {showFamily && familySiblings.map(sibling => {
              // For siblings we don't have a runQuantity — use the sibling's
              // own suggested quantity so the row is still meaningful.
              const rows = buildRows(
                sibling,
                sibling.suggestedQty || sibling.fgSOH || 0,
                bomByParent,
                sohView,
                globalSOH,
                packagingSOH,
                supplierByCode,
                productGroups,
                nameByCode,
              );
              return (
                <div key={sibling.productCode} className="mt-4">
                  <div className="text-xs mb-1" style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>
                    {sibling.productName}{' '}
                    <span style={{ color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                      ({sibling.productCode}, suggest {sibling.suggestedQty.toLocaleString()} units)
                    </span>
                  </div>
                  <ComponentTable
                    rows={rows}
                    onDraftPO={(row) => setDraftFor({ kind: 'po', row })}
                    onDraftTransfer={(row) => setDraftFor({ kind: 'transfer', row })}
                  />
                </div>
              );
            })}
          </section>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────

function ComponentTable({
  rows,
  onDraftPO,
  onDraftTransfer,
}: {
  rows: ComponentRow[];
  onDraftPO: (row: ComponentRow) => void;
  onDraftTransfer: (row: ComponentRow) => void;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        No BOM entries available for this product.
      </p>
    );
  }
  return (
    <div className="rounded overflow-hidden" style={{ border: '0.5px solid var(--border)' }}>
      <table className="w-full text-xs" style={{ tableLayout: 'fixed' }}>
        <thead style={{ background: 'var(--bg-surface)' }}>
          <tr style={{ color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
            <th className="text-left px-3 py-2" style={{ width: '30%' }}>Component</th>
            <th className="text-left px-3 py-2" style={{ width: '14%' }}>Type</th>
            <th className="text-right px-3 py-2" style={{ width: '12%' }}>Required</th>
            <th className="text-right px-3 py-2" style={{ width: '12%' }}>SOH (packaging)</th>
            <th className="text-right px-3 py-2" style={{ width: '12%' }}>SOH (global)</th>
            <th className="text-right px-3 py-2" style={{ width: '20%' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const globalShort = row.sohGlobal < row.required;
            const needsTransfer = !globalShort && row.sohAtPackaging < row.required;
            const statusColor = globalShort
              ? 'var(--danger)'
              : needsTransfer
                ? 'var(--warning)'
                : 'var(--success)';
            return (
              <tr key={row.code} style={{ borderTop: '0.5px solid var(--border)' }}>
                <td className="px-3 py-2" style={{ color: 'var(--text-primary)' }}>
                  <div style={{ fontWeight: 500 }}>{row.name}</div>
                  <div style={{ fontFamily: 'monospace', color: 'var(--text-muted)' }}>
                    {row.code}{row.supplier ? ` · ${row.supplier.name}` : ''}
                  </div>
                </td>
                <td className="px-3 py-2" style={{ color: 'var(--text-secondary)' }}>
                  <span
                    className="inline-block px-1.5 py-0.5 rounded"
                    style={{
                      fontSize: 10,
                      fontWeight: 500,
                      background: statusColor,
                      color: 'white',
                      letterSpacing: '0.03em',
                      textTransform: 'uppercase',
                    }}
                    title={
                      globalShort
                        ? 'Global shortfall — PO needed'
                        : needsTransfer
                          ? 'Globally fine, transfer needed to MF Packaging'
                          : 'OK at MF Packaging'
                    }
                  >
                    {row.kind}
                  </span>
                </td>
                <td className="px-3 py-2 text-right" style={{ fontFamily: 'monospace', color: 'var(--text-primary)' }}>
                  {round(row.required)} {row.unit}
                </td>
                <td
                  className="px-3 py-2 text-right"
                  style={{
                    fontFamily: 'monospace',
                    color: row.sohAtPackaging < row.required ? 'var(--warning)' : 'var(--text-secondary)',
                  }}
                >
                  {round(row.sohAtPackaging)}
                </td>
                <td
                  className="px-3 py-2 text-right"
                  style={{
                    fontFamily: 'monospace',
                    color: row.sohGlobal < row.required ? 'var(--danger)' : 'var(--text-secondary)',
                  }}
                >
                  {round(row.sohGlobal)}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => onDraftPO(row)}
                    className="text-[10px] px-2 py-0.5 rounded transition hover:opacity-80"
                    style={{ color: 'var(--accent)', border: '0.5px solid var(--accent)', fontWeight: 500, marginRight: 4 }}
                    title="Create a draft purchase order for this component"
                  >
                    + PO
                  </button>
                  <button
                    onClick={() => onDraftTransfer(row)}
                    className="text-[10px] px-2 py-0.5 rounded transition hover:opacity-80"
                    style={{ color: 'var(--warning)', border: '0.5px solid var(--warning)', fontWeight: 500 }}
                    title="Create a draft warehouse transfer to MF Packaging"
                  >
                    → TX
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-[10px] mb-1 uppercase tracking-wide" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded px-3 py-1.5 text-sm focus:outline-none"
        style={{ border: '0.5px solid var(--border)', background: 'var(--bg-page)', color: 'var(--text-primary)' }}
      />
    </div>
  );
}

function LabeledSelect({
  label,
  value,
  onChange,
  options,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
}) {
  // If the auto-picked value isn't in the options list (possible when the
  // warehouse name in SOH data has extra whitespace or a typo), include it
  // as the first option so the operator can see what was guessed and pick a
  // different one if they want.
  const finalOptions = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <div>
      <label className="block text-[10px] mb-1 uppercase tracking-wide" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded px-3 py-1.5 text-sm focus:outline-none"
        style={{ border: '0.5px solid var(--border)', background: 'var(--bg-page)', color: 'var(--text-primary)' }}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {finalOptions.map(opt => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </div>
  );
}

function FormActions({
  onSave,
  onCancel,
  saveLabel,
  accent = 'accent',
}: {
  onSave: () => void;
  onCancel: () => void;
  saveLabel: string;
  accent?: 'accent' | 'warning';
}) {
  return (
    <div className="flex justify-end gap-2">
      <button
        onClick={onCancel}
        className="px-3 py-1 rounded text-xs transition hover:opacity-80"
        style={{ color: 'var(--text-secondary)', border: '0.5px solid var(--border)' }}
      >
        Cancel
      </button>
      <button
        onClick={onSave}
        className="px-3 py-1 rounded text-xs text-white transition hover:opacity-80"
        style={{ background: accent === 'warning' ? 'var(--warning)' : 'var(--accent)', fontWeight: 500 }}
      >
        {saveLabel}
      </button>
    </div>
  );
}
