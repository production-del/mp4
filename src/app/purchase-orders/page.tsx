'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import type { PurchaseOrder, PurchaseOrderLine } from '@/lib/unleashed/types';

// ─── Types ─────────────────────────────────────────────────

type ViewMode = 'sku' | 'supplier';
type StatusFilter = 'all' | 'Open' | 'PartiallyReceived';
type SortKey = 'productCode' | 'productName' | 'qtyOrdered' | 'qtyReceived' | 'outstanding' | 'unitPrice' | 'lineTotal' | 'poNumber' | 'supplier' | 'status' | 'expectedDate' | 'orderedDate';
type SupplierSortKey = 'supplierName' | 'poCount' | 'lineCount' | 'totalValue' | 'oldestOrder';

// Flattened line-level row for SKU view
interface POLineRow {
  key: string;
  productCode: string;
  productDescription: string;
  quantityOrdered: number;
  quantityReceived: number;
  outstanding: number;
  unitAmount: number;
  lineTotal: number;
  poNumber: string;
  poId: string;
  supplierName: string;
  supplierCode: string;
  status: string;
  orderedDate: string;
  expectedDeliveryDate: string;
  lineExpectedDate: string;
}

// Supplier group for supplier view
interface SupplierGroup {
  supplierName: string;
  supplierCode: string;
  pos: PurchaseOrder[];
  totalLines: number;
  totalValue: number;
  oldestOrder: string;
  totalOutstanding: number;
}

// ─── Helpers ───────────────────────────────────────────────

function formatDate(iso: string | undefined): string {
  if (!iso) return '\u2014';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '\u2014';
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: '2-digit' });
}

function formatCurrency(n: number): string {
  return '$' + n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function statusStyle(status: string): { bg: string; fg: string } {
  switch (status) {
    case 'Open': return { bg: 'rgba(37, 99, 235, 0.10)', fg: 'var(--accent)' };
    case 'PartiallyReceived': return { bg: 'rgba(180, 83, 9, 0.10)', fg: 'var(--warning)' };
    case 'Received': return { bg: 'rgba(21, 128, 61, 0.10)', fg: 'var(--success)' };
    case 'Cancelled': return { bg: 'rgba(185, 28, 28, 0.08)', fg: 'var(--danger)' };
    default: return { bg: 'var(--bg-surface)', fg: 'var(--text-secondary)' };
  }
}

function statusLabel(status: string): string {
  if (status === 'PartiallyReceived') return 'Partial';
  return status;
}

function pctReceived(ordered: number, received: number): number {
  if (ordered <= 0) return 0;
  return Math.min(100, Math.round((received / ordered) * 100));
}

// ─── Main component ───────────────────────────────────────

export default function PurchaseOrdersPage() {
  const [pos, setPOs] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [viewMode, setViewMode] = useState<ViewMode>('sku');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('expectedDate');
  const [sortAsc, setSortAsc] = useState(true);
  const [supplierSort, setSupplierSort] = useState<SupplierSortKey>('supplierName');
  const [supplierSortAsc, setSupplierSortAsc] = useState(true);

  // ── Fetch ──
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/purchasing-data');
      const json = await res.json();
      if (json.success) {
        const all: PurchaseOrder[] = [...(json.data.openPOs || []), ...(json.data.partialPOs || [])];
        setPOs(all);
        setError(null);
      } else {
        setError(json.error || 'Failed to load');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Filtered POs ──
  const filteredPOs = useMemo(() => {
    let result = pos;
    if (statusFilter !== 'all') result = result.filter(po => po.status === statusFilter);
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      result = result.filter(po =>
        po.purchaseOrderNumber.toLowerCase().includes(q) ||
        po.supplierName.toLowerCase().includes(q) ||
        po.supplierCode.toLowerCase().includes(q) ||
        po.purchaseOrderLines.some(l =>
          l.productCode.toLowerCase().includes(q) ||
          l.productDescription.toLowerCase().includes(q)
        )
      );
    }
    return result;
  }, [pos, statusFilter, search]);

  // ── Stats ──
  const stats = useMemo(() => {
    const open = pos.filter(p => p.status === 'Open').length;
    const partial = pos.filter(p => p.status === 'PartiallyReceived').length;
    const totalValue = pos.reduce((s, p) => s + p.orderTotal, 0);
    const totalLines = pos.reduce((s, p) => s + p.purchaseOrderLines.length, 0);
    const uniqueSuppliers = new Set(pos.map(p => p.supplierCode)).size;
    return { total: pos.length, open, partial, totalValue, totalLines, uniqueSuppliers };
  }, [pos]);

  // ── SKU View: Flatten PO lines ──
  const lineRows = useMemo((): POLineRow[] => {
    const rows: POLineRow[] = [];
    for (const po of filteredPOs) {
      for (const line of po.purchaseOrderLines) {
        rows.push({
          key: `${po.purchaseOrderId}-${line.lineNumber}`,
          productCode: line.productCode,
          productDescription: line.productDescription,
          quantityOrdered: line.quantityOrdered,
          quantityReceived: line.quantityReceived,
          outstanding: line.quantityOrdered - line.quantityReceived,
          unitAmount: line.unitAmount,
          lineTotal: line.lineTotal,
          poNumber: po.purchaseOrderNumber,
          poId: po.purchaseOrderId,
          supplierName: po.supplierName,
          supplierCode: po.supplierCode,
          status: po.status,
          orderedDate: po.orderedDate,
          expectedDeliveryDate: po.expectedDeliveryDate || '',
          lineExpectedDate: line.expectedDeliveryDate || po.expectedDeliveryDate || '',
        });
      }
    }
    // Sort
    rows.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'productCode': cmp = a.productCode.localeCompare(b.productCode); break;
        case 'productName': cmp = a.productDescription.localeCompare(b.productDescription); break;
        case 'qtyOrdered': cmp = a.quantityOrdered - b.quantityOrdered; break;
        case 'qtyReceived': cmp = a.quantityReceived - b.quantityReceived; break;
        case 'outstanding': cmp = a.outstanding - b.outstanding; break;
        case 'unitPrice': cmp = a.unitAmount - b.unitAmount; break;
        case 'lineTotal': cmp = a.lineTotal - b.lineTotal; break;
        case 'poNumber': cmp = a.poNumber.localeCompare(b.poNumber); break;
        case 'supplier': cmp = a.supplierName.localeCompare(b.supplierName); break;
        case 'status': cmp = a.status.localeCompare(b.status); break;
        case 'expectedDate': cmp = a.lineExpectedDate.localeCompare(b.lineExpectedDate); break;
        case 'orderedDate': cmp = a.orderedDate.localeCompare(b.orderedDate); break;
      }
      return sortAsc ? cmp : -cmp;
    });
    return rows;
  }, [filteredPOs, sortKey, sortAsc]);

  // ── Supplier View: Group by supplier ──
  const supplierGroups = useMemo((): SupplierGroup[] => {
    const map = new Map<string, SupplierGroup>();
    for (const po of filteredPOs) {
      let g = map.get(po.supplierCode);
      if (!g) {
        g = {
          supplierName: po.supplierName,
          supplierCode: po.supplierCode,
          pos: [],
          totalLines: 0,
          totalValue: 0,
          oldestOrder: po.orderedDate,
          totalOutstanding: 0,
        };
        map.set(po.supplierCode, g);
      }
      g.pos.push(po);
      g.totalLines += po.purchaseOrderLines.length;
      g.totalValue += po.orderTotal;
      if (po.orderedDate < g.oldestOrder) g.oldestOrder = po.orderedDate;
      for (const line of po.purchaseOrderLines) {
        g.totalOutstanding += Math.max(0, line.quantityOrdered - line.quantityReceived);
      }
    }
    const groups = [...map.values()];
    groups.sort((a, b) => {
      let cmp = 0;
      switch (supplierSort) {
        case 'supplierName': cmp = a.supplierName.localeCompare(b.supplierName); break;
        case 'poCount': cmp = a.pos.length - b.pos.length; break;
        case 'lineCount': cmp = a.totalLines - b.totalLines; break;
        case 'totalValue': cmp = a.totalValue - b.totalValue; break;
        case 'oldestOrder': cmp = a.oldestOrder.localeCompare(b.oldestOrder); break;
      }
      return supplierSortAsc ? cmp : -cmp;
    });
    return groups;
  }, [filteredPOs, supplierSort, supplierSortAsc]);

  // ── Sort handlers ──
  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(p => !p);
    else { setSortKey(key); setSortAsc(true); }
  };
  const toggleSupplierSort = (key: SupplierSortKey) => {
    if (supplierSort === key) setSupplierSortAsc(p => !p);
    else { setSupplierSort(key); setSupplierSortAsc(true); }
  };

  // ── Render ──
  return (
    <div className="h-screen flex flex-col max-w-[95%] mx-auto w-full" style={{ background: 'var(--bg-page)' }}>
      {/* Error */}
      {error && (
        <div className="px-6 py-2 flex items-center justify-between text-sm" style={{ background: 'var(--danger-light)', color: 'var(--danger)', borderBottom: '0.5px solid var(--border)' }}>
          <span>{error}</span>
          <button onClick={fetchData} className="underline opacity-70 hover:opacity-100 text-xs">Retry</button>
        </div>
      )}

      {/* Header */}
      <div className="px-6 pt-4 pb-3" style={{ borderBottom: '0.5px solid var(--border)', position: 'sticky', top: 0, zIndex: 20, background: 'var(--bg-page)' }}>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>Purchase Orders</h1>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Open and partially received orders from Unleashed</p>
          </div>
          <button onClick={fetchData} className="px-2.5 py-1 rounded text-sm transition hover:opacity-80" style={{ color: 'var(--text-secondary)', border: '0.5px solid var(--border)' }}>
            Refresh
          </button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="px-6 pt-3 pb-3" style={{ borderBottom: '0.5px solid var(--border)' }}>
        <div className="grid grid-cols-6 gap-3">
          {[
            { label: 'Total POs', value: stats.total },
            { label: 'Open', value: stats.open, color: stats.open > 0 ? 'var(--accent)' : undefined },
            { label: 'Partial', value: stats.partial, color: stats.partial > 0 ? 'var(--warning)' : undefined },
            { label: 'Suppliers', value: stats.uniqueSuppliers },
            { label: 'Lines', value: stats.totalLines },
            { label: 'Total Value', value: formatCurrency(stats.totalValue), small: true },
          ].map((c) => (
            <div key={c.label} className="rounded px-3 py-2" style={{ background: 'var(--bg-surface)' }}>
              <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>{c.label}</div>
              <div className={c.small ? 'text-sm mt-0.5' : 'text-xl mt-0.5'} style={{ fontWeight: 500, color: (c as { color?: string }).color || 'var(--text-primary)' }}>
                {c.value}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 px-6 py-2" style={{ borderBottom: '0.5px solid var(--border)' }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search PO#, supplier, product..."
          className="w-56 px-2.5 py-1 rounded text-sm placeholder:opacity-40 focus:outline-none"
          style={{ color: 'var(--text-primary)', background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }}
        />
        {/* Status filter */}
        <div className="flex rounded overflow-hidden" style={{ border: '0.5px solid var(--border)' }}>
          {(['all', 'Open', 'PartiallyReceived'] as StatusFilter[]).map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className="px-2.5 py-1 text-xs transition"
              style={{
                fontWeight: statusFilter === s ? 500 : 400,
                color: statusFilter === s ? 'var(--accent)' : 'var(--text-muted)',
                background: statusFilter === s ? 'var(--accent-light)' : 'transparent',
              }}
            >
              {s === 'all' ? 'All' : s === 'PartiallyReceived' ? 'Partial' : s}
            </button>
          ))}
        </div>
        {/* View toggle */}
        <div className="ml-auto flex rounded overflow-hidden" style={{ border: '0.5px solid var(--border)' }}>
          {(['sku', 'supplier'] as ViewMode[]).map(v => (
            <button
              key={v}
              onClick={() => setViewMode(v)}
              className="px-2.5 py-1 text-xs capitalize transition"
              style={{
                fontWeight: viewMode === v ? 500 : 400,
                color: viewMode === v ? 'var(--accent)' : 'var(--text-muted)',
                background: viewMode === v ? 'var(--accent-light)' : 'transparent',
              }}
            >
              {v === 'sku' ? 'By SKU' : 'By Supplier'}
            </button>
          ))}
        </div>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {viewMode === 'sku'
            ? `${lineRows.length} line${lineRows.length !== 1 ? 's' : ''}`
            : `${supplierGroups.length} supplier${supplierGroups.length !== 1 ? 's' : ''}`}
        </span>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="text-sm mb-2" style={{ color: 'var(--text-muted)' }}>Loading purchase orders...</div>
            <div className="w-48 h-0.5 rounded overflow-hidden" style={{ background: 'var(--bg-surface)' }}>
              <div className="h-full rounded animate-pulse" style={{ width: '60%', background: 'var(--accent)' }} />
            </div>
          </div>
        </div>
      ) : viewMode === 'sku' ? (
        <SKUView rows={lineRows} sortKey={sortKey} sortAsc={sortAsc} toggleSort={toggleSort} />
      ) : (
        <SupplierView groups={supplierGroups} sortKey={supplierSort} sortAsc={supplierSortAsc} toggleSort={toggleSupplierSort} />
      )}
    </div>
  );
}

// ─── SKU View ─────────────────────────────────────────────

function SKUView({
  rows, sortKey, sortAsc, toggleSort,
}: {
  rows: POLineRow[];
  sortKey: SortKey;
  sortAsc: boolean;
  toggleSort: (key: SortKey) => void;
}) {
  const cols: { key: SortKey; label: string; align: 'left' | 'right' | 'center'; width: string }[] = [
    { key: 'status', label: 'Status', align: 'center', width: '6%' },
    { key: 'poNumber', label: 'PO #', align: 'left', width: '8%' },
    { key: 'productCode', label: 'Product', align: 'left', width: '10%' },
    { key: 'productName', label: 'Description', align: 'left', width: '18%' },
    { key: 'supplier', label: 'Supplier', align: 'left', width: '12%' },
    { key: 'qtyOrdered', label: 'Ordered', align: 'right', width: '7%' },
    { key: 'qtyReceived', label: 'Received', align: 'right', width: '7%' },
    { key: 'outstanding', label: 'Outstdg', align: 'right', width: '7%' },
    { key: 'unitPrice', label: 'Unit $', align: 'right', width: '7%' },
    { key: 'lineTotal', label: 'Line $', align: 'right', width: '7%' },
    { key: 'orderedDate', label: 'Ordered', align: 'right', width: '8%' },
    { key: 'expectedDate', label: 'Expected', align: 'right', width: '8%' },
  ];

  return (
    <div className="flex-1 overflow-y-auto px-6 py-3">
      <div className="overflow-x-auto" style={{ border: '0.5px solid var(--border)', borderRadius: 6 }}>
        <table style={{ tableLayout: 'fixed', width: '100%', minWidth: 1200 }}>
          <colgroup>
            {cols.map(c => <col key={c.key} style={{ width: c.width }} />)}
          </colgroup>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)' }}>
              {cols.map(c => {
                const active = sortKey === c.key;
                return (
                  <th
                    key={c.key}
                    onClick={() => toggleSort(c.key)}
                    className={`px-2 py-1.5 text-[11px] uppercase tracking-wider cursor-pointer select-none transition hover:opacity-70 ${
                      c.align === 'left' ? 'text-left' : c.align === 'center' ? 'text-center' : 'text-right'
                    }`}
                    style={{ fontWeight: 500, color: active ? 'var(--accent)' : 'var(--text-muted)', position: 'sticky', top: 0, background: 'var(--bg-surface)', zIndex: 2 }}
                  >
                    {c.label}
                    {active && <span className="ml-0.5 text-[9px]">{sortAsc ? '\u25B2' : '\u25BC'}</span>}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const st = statusStyle(row.status);
              const pct = pctReceived(row.quantityOrdered, row.quantityReceived);
              return (
                <tr
                  key={row.key}
                  className="transition text-sm"
                  style={{ borderBottom: '0.5px solid var(--border)' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-surface)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = ''; }}
                >
                  <td className="px-2 py-1.5 text-center">
                    <span className="inline-block px-1.5 py-0.5 rounded text-[11px]" style={{ fontWeight: 500, color: st.fg, background: st.bg }}>
                      {statusLabel(row.status)}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{row.poNumber}</td>
                  <td className="px-2 py-1.5 font-mono truncate" title={row.productCode}>{row.productCode}</td>
                  <td className="px-2 py-1.5 truncate" style={{ color: 'var(--text-secondary)' }} title={row.productDescription}>{row.productDescription}</td>
                  <td className="px-2 py-1.5 truncate" style={{ color: 'var(--text-secondary)' }} title={row.supplierName}>{row.supplierName}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{row.quantityOrdered.toLocaleString()}</td>
                  <td className="px-2 py-1.5 text-right font-mono" style={{ color: pct >= 100 ? 'var(--success)' : pct > 0 ? 'var(--warning)' : 'var(--text-muted)' }}>
                    {row.quantityReceived > 0 ? row.quantityReceived.toLocaleString() : '\u2014'}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono" style={{
                    fontWeight: row.outstanding > 0 ? 500 : 400,
                    color: row.outstanding > 0 ? 'var(--text-primary)' : 'var(--text-muted)',
                    background: row.outstanding > 0 && row.status === 'PartiallyReceived' ? 'rgba(180, 83, 9, 0.06)' : undefined,
                  }}>
                    {row.outstanding > 0 ? row.outstanding.toLocaleString() : '\u2014'}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
                    {row.unitAmount > 0 ? formatCurrency(row.unitAmount) : '\u2014'}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {row.lineTotal > 0 ? formatCurrency(row.lineTotal) : '\u2014'}
                  </td>
                  <td className="px-2 py-1.5 text-right text-xs" style={{ color: 'var(--text-muted)' }}>{formatDate(row.orderedDate)}</td>
                  <td className="px-2 py-1.5 text-right text-xs" style={{
                    color: row.lineExpectedDate ? 'var(--text-primary)' : 'var(--text-muted)',
                    fontWeight: row.lineExpectedDate ? 500 : 400,
                  }}>
                    {formatDate(row.lineExpectedDate)}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={12} className="text-center py-8 text-sm" style={{ color: 'var(--text-muted)' }}>
                  No purchase order lines match your filters
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Supplier View ────────────────────────────────────────

function SupplierView({
  groups, sortKey, sortAsc, toggleSort,
}: {
  groups: SupplierGroup[];
  sortKey: SupplierSortKey;
  sortAsc: boolean;
  toggleSort: (key: SupplierSortKey) => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto px-6 py-3">
      {/* Sort controls */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Sort by:</span>
        {([
          { key: 'supplierName' as SupplierSortKey, label: 'Name' },
          { key: 'poCount' as SupplierSortKey, label: 'POs' },
          { key: 'totalValue' as SupplierSortKey, label: 'Value' },
          { key: 'lineCount' as SupplierSortKey, label: 'Lines' },
          { key: 'oldestOrder' as SupplierSortKey, label: 'Oldest' },
        ]).map(s => {
          const active = sortKey === s.key;
          return (
            <button
              key={s.key}
              onClick={() => toggleSort(s.key)}
              className="px-2 py-0.5 rounded text-xs transition hover:opacity-70"
              style={{
                fontWeight: active ? 500 : 400,
                color: active ? 'var(--accent)' : 'var(--text-muted)',
                background: active ? 'var(--accent-light)' : 'transparent',
                border: `0.5px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
              }}
            >
              {s.label}
              {active && <span className="ml-0.5 text-[9px]">{sortAsc ? '\u25B2' : '\u25BC'}</span>}
            </button>
          );
        })}
      </div>

      {groups.length === 0 ? (
        <div className="text-center py-8 text-sm" style={{ color: 'var(--text-muted)' }}>
          No purchase orders match your filters
        </div>
      ) : (
        groups.map(group => <SupplierCard key={group.supplierCode} group={group} />)
      )}
    </div>
  );
}

// ─── Supplier Card ────────────────────────────────────────

function SupplierCard({ group }: { group: SupplierGroup }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mb-2" style={{ border: '0.5px solid var(--border)', borderRadius: 6 }}>
      {/* Header */}
      <button
        onClick={() => setExpanded(p => !p)}
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition hover:opacity-80"
        style={{ background: 'var(--bg-surface)', borderRadius: expanded ? '6px 6px 0 0' : 6 }}
      >
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{expanded ? '\u25BC' : '\u25B6'}</span>
        <span className="text-sm truncate" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
          {group.supplierName}
        </span>
        <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>({group.supplierCode})</span>
        <div className="ml-auto flex items-center gap-4 flex-shrink-0">
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {group.pos.length} PO{group.pos.length !== 1 ? 's' : ''}
          </span>
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {group.totalLines} line{group.totalLines !== 1 ? 's' : ''}
          </span>
          {group.totalOutstanding > 0 && (
            <span className="text-xs font-mono" style={{ fontWeight: 500, color: 'var(--warning)' }}>
              {group.totalOutstanding.toLocaleString()} outstanding
            </span>
          )}
          <span className="text-xs font-mono" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
            {formatCurrency(group.totalValue)}
          </span>
        </div>
      </button>

      {/* Expanded: PO list */}
      {expanded && (
        <div style={{ borderTop: '0.5px solid var(--border)' }}>
          {group.pos.map(po => (
            <POCard key={po.purchaseOrderId} po={po} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Individual PO Card ───────────────────────────────────

function POCard({ po }: { po: PurchaseOrder }) {
  const [showLines, setShowLines] = useState(false);
  const st = statusStyle(po.status);
  const totalOrdered = po.purchaseOrderLines.reduce((s, l) => s + l.quantityOrdered, 0);
  const totalReceived = po.purchaseOrderLines.reduce((s, l) => s + l.quantityReceived, 0);
  const pct = pctReceived(totalOrdered, totalReceived);

  return (
    <div style={{ borderBottom: '0.5px solid var(--border)' }}>
      {/* PO header row */}
      <button
        onClick={() => setShowLines(p => !p)}
        className="w-full flex items-center gap-3 px-6 py-2 text-left transition hover:opacity-80"
      >
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{showLines ? '\u25BC' : '\u25B6'}</span>
        <span className="inline-block px-1.5 py-0.5 rounded text-[11px]" style={{ fontWeight: 500, color: st.fg, background: st.bg }}>
          {statusLabel(po.status)}
        </span>
        <span className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{po.purchaseOrderNumber}</span>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {po.purchaseOrderLines.length} line{po.purchaseOrderLines.length !== 1 ? 's' : ''}
        </span>
        {/* Progress bar for partial */}
        {po.status === 'PartiallyReceived' && (
          <div className="flex items-center gap-1.5">
            <div className="w-16 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-surface)' }}>
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: 'var(--warning)' }} />
            </div>
            <span className="text-[10px] font-mono" style={{ color: 'var(--warning)' }}>{pct}%</span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-4 flex-shrink-0">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Ordered {formatDate(po.orderedDate)}
          </span>
          {po.expectedDeliveryDate && (
            <span className="text-xs" style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
              ETA {formatDate(po.expectedDeliveryDate)}
            </span>
          )}
          <span className="text-xs font-mono" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
            {formatCurrency(po.orderTotal)}
          </span>
        </div>
      </button>

      {/* PO lines table */}
      {showLines && (
        <div className="px-6 pb-2">
          <table className="w-full" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '12%' }} />
              <col style={{ width: '28%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '10%' }} />
            </colgroup>
            <thead>
              <tr style={{ borderBottom: '0.5px solid var(--border)' }}>
                {['Product', 'Description', 'Ordered', 'Received', 'Outstdg', 'Unit $', 'Line $', 'ETA'].map((h, i) => (
                  <th key={h} className={`px-2 py-1 text-[10px] uppercase tracking-wider ${i < 2 ? 'text-left' : 'text-right'}`} style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {po.purchaseOrderLines.map(line => {
                const out = line.quantityOrdered - line.quantityReceived;
                const linePct = pctReceived(line.quantityOrdered, line.quantityReceived);
                return (
                  <tr key={line.lineNumber} className="text-xs" style={{ borderBottom: '0.5px solid var(--border)' }}>
                    <td className="px-2 py-1 font-mono truncate" title={line.productCode}>{line.productCode}</td>
                    <td className="px-2 py-1 truncate" style={{ color: 'var(--text-secondary)' }} title={line.productDescription}>{line.productDescription}</td>
                    <td className="px-2 py-1 text-right font-mono">{line.quantityOrdered.toLocaleString()}</td>
                    <td className="px-2 py-1 text-right font-mono" style={{ color: linePct >= 100 ? 'var(--success)' : linePct > 0 ? 'var(--warning)' : 'var(--text-muted)' }}>
                      {line.quantityReceived > 0 ? line.quantityReceived.toLocaleString() : '\u2014'}
                    </td>
                    <td className="px-2 py-1 text-right font-mono" style={{ fontWeight: out > 0 ? 500 : 400, color: out > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                      {out > 0 ? out.toLocaleString() : '\u2014'}
                    </td>
                    <td className="px-2 py-1 text-right font-mono" style={{ color: 'var(--text-muted)' }}>
                      {line.unitAmount > 0 ? formatCurrency(line.unitAmount) : '\u2014'}
                    </td>
                    <td className="px-2 py-1 text-right font-mono" style={{ color: 'var(--text-secondary)' }}>
                      {line.lineTotal > 0 ? formatCurrency(line.lineTotal) : '\u2014'}
                    </td>
                    <td className="px-2 py-1 text-right" style={{ color: line.expectedDeliveryDate ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                      {formatDate(line.expectedDeliveryDate)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
