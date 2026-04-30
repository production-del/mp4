'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import type { Assembly } from '@/lib/unleashed/types';
import { dayIntToReadable, formatISOFull } from '@/lib/planning/working-day';
import { listByKind } from '@/lib/planning/plan-draft-store';

// ─── Types ─────────────────────────────────────────────────

interface DraftAssembly {
  productCode: string;
  quantity: number;
  dayInt: number;
  source: 'new' | 'existing';
  existingAssemblyId?: string;
}

type ViewFilter = 'all' | 'confirmed' | 'planned';
type StatusFilter = 'all' | 'Open' | 'Planned' | 'Parked';

// ─── Helpers ───────────────────────────────────────────────

/** Local alias: use the shared ISO formatter but display '-' for empty/invalid. */
function formatDate(iso: string): string {
  if (!iso) return '-';
  const out = formatISOFull(iso);
  return out === '—' ? '-' : out;
}

function statusColor(status: string): { bg: string; fg: string } {
  switch (status) {
    case 'Open': return { bg: 'rgba(21, 128, 61, 0.12)', fg: 'var(--success)' };
    case 'Planned': return { bg: 'rgba(37, 99, 235, 0.12)', fg: 'var(--accent)' };
    case 'Parked': return { bg: 'rgba(180, 83, 9, 0.10)', fg: 'var(--warning)' };
    case 'Draft (New)': return { bg: 'rgba(37, 99, 235, 0.08)', fg: 'var(--accent)' };
    case 'Draft (Edit)': return { bg: 'rgba(180, 83, 9, 0.08)', fg: 'var(--warning)' };
    default: return { bg: 'var(--bg-surface)', fg: 'var(--text-secondary)' };
  }
}

// ─── Unified row type ──────────────────────────────────────

interface AssemblyRow {
  id: string;
  assemblyNumber: string;
  productCode: string;
  productName: string;
  quantity: number;
  status: string;
  warehouse: string;
  date: string;
  dateLabel: string;
  origin: 'unleashed' | 'draft';
  componentCount: number;
  primaryComponent: string;
  primaryComponentQty: number;
}

// ─── Data loading ──────────────────────────────────────────

function loadDraftAssemblies(): DraftAssembly[] {
  try {
    const items = listByKind('packaging_run');
    return items
      .filter(i => i.quantity > 0)
      .map(i => ({
        productCode: i.productCode,
        quantity: i.quantity,
        dayInt: i.dayInt,
        source: i.action === 'CREATE' ? 'new' as const : 'existing' as const,
      }));
  } catch {
    return [];
  }
}

// ─── Page ──────────────────────────────────────────────────

export default function AssembliesPage() {
  const [confirmedAssemblies, setConfirmedAssemblies] = useState<Assembly[]>([]);
  const [draftAssemblies, setDraftAssemblies] = useState<DraftAssembly[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [viewFilter, setViewFilter] = useState<ViewFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortKey, setSortKey] = useState<'date' | 'code' | 'qty' | 'status'>('date');
  const [sortAsc, setSortAsc] = useState(false);

  // Fetch confirmed assemblies from API
  const fetchAssemblies = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/packaging-data');
      const json = await res.json();
      if (json.success && json.data?.assemblies) {
        setConfirmedAssemblies(json.data.assemblies);
      } else {
        setError(json.error || 'Failed to load assemblies');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAssemblies();
    setDraftAssemblies(loadDraftAssemblies());

    const onFocus = () => setDraftAssemblies(loadDraftAssemblies());
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [fetchAssemblies]);

  // Build unified rows
  const allRows = useMemo((): AssemblyRow[] => {
    const rows: AssemblyRow[] = [];

    // Confirmed from Unleashed
    for (const a of confirmedAssemblies) {
      const primary = a.assemblyLines.reduce(
        (best, line) => (line.componentQuantity > best.qty ? { code: line.productCode, qty: line.componentQuantity } : best),
        { code: '', qty: 0 }
      );
      rows.push({
        id: a.assemblyId,
        assemblyNumber: a.assemblyNumber,
        productCode: a.productCode,
        productName: a.productName,
        quantity: a.quantity,
        status: a.status,
        warehouse: a.warehouseName,
        date: a.createdOn,
        dateLabel: formatDate(a.createdOn),
        origin: 'unleashed',
        componentCount: a.assemblyLines.length,
        primaryComponent: primary.code,
        primaryComponentQty: primary.qty,
      });
    }

    // Drafts from localStorage (exclude existing edits that match a confirmed assembly)
    const confirmedIds = new Set(confirmedAssemblies.map(a => a.productCode));
    for (const d of draftAssemblies) {
      if (d.source === 'existing') {
        // Draft edit of existing — show separately
        rows.push({
          id: `draft-edit-${d.productCode}`,
          assemblyNumber: '-',
          productCode: d.productCode,
          productName: d.productCode,
          quantity: d.quantity,
          status: 'Draft (Edit)',
          warehouse: '-',
          date: '',
          dateLabel: d.dayInt > 0 ? dayIntToReadable(d.dayInt) : 'No date',
          origin: 'draft',
          componentCount: 0,
          primaryComponent: '',
          primaryComponentQty: 0,
        });
      } else {
        // New draft
        rows.push({
          id: `draft-new-${d.productCode}`,
          assemblyNumber: '-',
          productCode: d.productCode,
          productName: d.productCode,
          quantity: d.quantity,
          status: 'Draft (New)',
          warehouse: '-',
          date: '',
          dateLabel: d.dayInt > 0 ? dayIntToReadable(d.dayInt) : 'No date',
          origin: 'draft',
          componentCount: 0,
          primaryComponent: '',
          primaryComponentQty: 0,
        });
      }
    }

    return rows;
  }, [confirmedAssemblies, draftAssemblies]);

  // Filter + sort
  const filteredRows = useMemo(() => {
    let result = allRows;

    // View filter
    if (viewFilter === 'confirmed') result = result.filter(r => r.origin === 'unleashed');
    if (viewFilter === 'planned') result = result.filter(r => r.origin === 'draft');

    // Status filter
    if (statusFilter !== 'all') result = result.filter(r => r.status === statusFilter);

    // Search
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(r =>
        r.productCode.toLowerCase().includes(q) ||
        r.productName.toLowerCase().includes(q) ||
        r.assemblyNumber.toLowerCase().includes(q) ||
        r.primaryComponent.toLowerCase().includes(q)
      );
    }

    // Sort
    result = [...result].sort((a, b) => {
      let c = 0;
      switch (sortKey) {
        case 'date': c = (a.date || 'z').localeCompare(b.date || 'z'); break;
        case 'code': c = a.productCode.localeCompare(b.productCode); break;
        case 'qty': c = a.quantity - b.quantity; break;
        case 'status': {
          const order: Record<string, number> = { 'Open': 0, 'Planned': 1, 'Parked': 2, 'Draft (New)': 3, 'Draft (Edit)': 4 };
          c = (order[a.status] ?? 5) - (order[b.status] ?? 5);
          break;
        }
      }
      return sortAsc ? c : -c;
    });

    return result;
  }, [allRows, viewFilter, statusFilter, search, sortKey, sortAsc]);

  const toggleSort = (key: typeof sortKey) => {
    if (sortKey === key) setSortAsc(p => !p);
    else { setSortKey(key); setSortAsc(key === 'code'); }
  };

  // Stats
  const stats = useMemo(() => ({
    confirmed: allRows.filter(r => r.origin === 'unleashed').length,
    open: allRows.filter(r => r.status === 'Open').length,
    planned: allRows.filter(r => r.status === 'Planned').length,
    parked: allRows.filter(r => r.status === 'Parked').length,
    drafts: allRows.filter(r => r.origin === 'draft').length,
    totalQty: allRows.reduce((s, r) => s + r.quantity, 0),
  }), [allRows]);

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center" style={{ background: 'var(--bg-page)' }}>
        <div className="text-center">
          <div className="text-lg mb-2" style={{ color: 'var(--text-muted)' }}>Loading assemblies...</div>
          <div className="w-48 h-0.5 rounded overflow-hidden" style={{ background: 'var(--bg-surface)' }}>
            <div className="h-full rounded animate-pulse" style={{ width: '60%', background: 'var(--accent)' }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: 'var(--bg-page)', color: 'var(--text-primary)' }}>
      {/* Header */}
      <div className="px-6 pt-5 pb-4" style={{ borderBottom: '0.5px solid var(--border)' }}>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl" style={{ fontWeight: 500 }}>Assemblies</h1>
            <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
              All confirmed assemblies from Unleashed and planned drafts from Packaging Plan
            </p>
          </div>
          <button
            onClick={fetchAssemblies}
            className="px-3 py-1.5 rounded text-sm transition hover:opacity-80"
            style={{ color: 'var(--text-secondary)', border: '0.5px solid var(--border)', fontWeight: 400 }}
          >
            Refresh
          </button>
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-6 gap-3 mt-4">
          {[
            { label: 'Confirmed', value: stats.confirmed, color: undefined },
            { label: 'Open', value: stats.open, color: stats.open > 0 ? 'var(--success)' : undefined },
            { label: 'Planned', value: stats.planned, color: stats.planned > 0 ? 'var(--accent)' : undefined },
            { label: 'Parked', value: stats.parked, color: stats.parked > 0 ? 'var(--warning)' : undefined },
            { label: 'Drafts', value: stats.drafts, color: stats.drafts > 0 ? 'var(--accent)' : undefined },
            { label: 'Total Qty', value: stats.totalQty.toLocaleString(), color: undefined },
          ].map(card => (
            <div key={card.label} className="rounded px-4 py-3" style={{ background: 'var(--bg-surface)' }}>
              <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                {card.label}
              </div>
              <div className="text-2xl mt-0.5" style={{ fontWeight: 500, color: card.color || 'var(--text-primary)' }}>
                {card.value}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-6 py-2 flex items-center justify-between" style={{ background: 'var(--danger-light)', color: 'var(--danger)', borderBottom: '0.5px solid var(--border)' }}>
          <span className="text-sm">{error}</span>
          <button onClick={fetchAssemblies} className="underline opacity-70 hover:opacity-100 text-sm">Retry</button>
        </div>
      )}

      {/* Filter bar */}
      <div className="px-6 py-3 flex items-center gap-3" style={{ borderBottom: '0.5px solid var(--border)' }}>
        <input
          type="text"
          placeholder="Search product, assembly #, component..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="rounded px-3 py-1.5 text-sm w-64 focus:outline-none"
          style={{ color: 'var(--text-primary)', background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }}
        />
        {/* View filter */}
        <div className="flex rounded overflow-hidden" style={{ border: '0.5px solid var(--border)' }}>
          {(['all', 'confirmed', 'planned'] as ViewFilter[]).map(v => (
            <button
              key={v}
              onClick={() => setViewFilter(v)}
              className="px-2.5 py-1 text-xs capitalize transition"
              style={{
                fontWeight: viewFilter === v ? 500 : 400,
                color: viewFilter === v ? 'var(--accent)' : 'var(--text-muted)',
                background: viewFilter === v ? 'var(--accent-light)' : 'transparent',
              }}
            >
              {v === 'planned' ? 'Drafts' : v}
            </button>
          ))}
        </div>
        {/* Status filter */}
        <div className="flex rounded overflow-hidden" style={{ border: '0.5px solid var(--border)' }}>
          {(['all', 'Open', 'Planned', 'Parked'] as StatusFilter[]).map(s => (
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
              {s}
            </button>
          ))}
        </div>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {filteredRows.length} assembl{filteredRows.length !== 1 ? 'ies' : 'y'}
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead>
            <tr>
              {[
                { key: 'status' as const, label: 'Status', w: '8%', align: 'left' },
                { key: 'code' as const, label: 'Assembly #', w: '10%', align: 'left' },
                { key: 'code' as const, label: 'Product Code', w: '14%', align: 'left' },
                { key: 'code' as const, label: 'Product Name', w: '20%', align: 'left' },
                { key: 'qty' as const, label: 'Qty', w: '7%', align: 'right' },
                { key: null, label: 'Component', w: '12%', align: 'left' },
                { key: null, label: 'Comp Qty', w: '8%', align: 'right' },
                { key: null, label: 'Warehouse', w: '10%', align: 'left' },
                { key: 'date' as const, label: 'Date', w: '11%', align: 'left' },
              ].map((col, i) => (
                <th
                  key={i}
                  className="px-3 py-2.5 text-xs uppercase tracking-wider select-none"
                  style={{
                    textAlign: col.align as any,
                    width: col.w,
                    fontWeight: 500,
                    color: col.key && sortKey === col.key ? 'var(--accent)' : 'var(--text-muted)',
                    background: 'var(--bg-surface)',
                    borderBottom: '0.5px solid var(--border)',
                    position: 'sticky',
                    top: 0,
                    zIndex: 2,
                    cursor: col.key ? 'pointer' : 'default',
                  }}
                  onClick={() => col.key && toggleSort(col.key)}
                >
                  {col.label}
                  {col.key && sortKey === col.key && (
                    <span className="ml-0.5 text-[9px]">{sortAsc ? '\u25B2' : '\u25BC'}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-6 py-12 text-center" style={{ color: 'var(--text-muted)' }}>
                  {search || viewFilter !== 'all' || statusFilter !== 'all' ? 'No assemblies match your filters' : 'No assemblies found'}
                </td>
              </tr>
            )}
            {filteredRows.map(row => {
              const sc = statusColor(row.status);
              return (
                <tr
                  key={row.id}
                  className="transition"
                  style={{ borderBottom: '0.5px solid var(--border)' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-surface)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = ''; }}
                >
                  {/* Status */}
                  <td className="px-3 py-2">
                    <span
                      className="text-[11px] px-1.5 py-0.5 rounded"
                      style={{ background: sc.bg, color: sc.fg, fontWeight: 600 }}
                    >
                      {row.status}
                    </span>
                  </td>
                  {/* Assembly # */}
                  <td className="px-3 py-2 font-mono" style={{ color: 'var(--text-secondary)' }}>
                    {row.assemblyNumber}
                  </td>
                  {/* Product Code */}
                  <td className="px-3 py-2 font-mono" style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                    {row.productCode}
                  </td>
                  {/* Product Name */}
                  <td className="px-3 py-2 truncate" style={{ color: 'var(--text-secondary)', maxWidth: 200 }} title={row.productName}>
                    {row.productName}
                  </td>
                  {/* Qty */}
                  <td className="px-3 py-2 text-right font-mono" style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                    {row.quantity.toLocaleString()}
                  </td>
                  {/* Primary Component */}
                  <td className="px-3 py-2 font-mono" style={{ color: row.primaryComponent ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                    {row.primaryComponent || '-'}
                    {row.componentCount > 1 && (
                      <span className="text-[10px] ml-1" style={{ color: 'var(--text-muted)' }}>
                        +{row.componentCount - 1}
                      </span>
                    )}
                  </td>
                  {/* Primary Component Qty */}
                  <td className="px-3 py-2 text-right font-mono" style={{ color: row.primaryComponentQty > 0 ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                    {row.primaryComponentQty > 0 ? Math.round(row.primaryComponentQty).toLocaleString() : '-'}
                  </td>
                  {/* Warehouse */}
                  <td className="px-3 py-2 truncate" style={{ color: 'var(--text-muted)', maxWidth: 120 }} title={row.warehouse}>
                    {row.warehouse}
                  </td>
                  {/* Date */}
                  <td className="px-3 py-2" style={{ color: 'var(--text-secondary)' }}>
                    {row.dateLabel}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
