'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import type { Product, Supplier, StockOnHandItem, Assembly, Warehouse } from '@/lib/unleashed/types';
import { INTERMEDIATE_REGISTRY, EQUIPMENT_COLORS } from '../kitchen/data/intermediate-registry';
import {
  buildAssignmentMap,
  saveOverride,
  removeOverride,
  type WarehouseAssignmentMap,
  type WarehouseAssignment,
} from '@/lib/planning/warehouse-assignments';
import { isPriority, setPriority, countEnabledFlags } from '@/lib/planning/priority-flags';

// ─── Types ──────────────────────────────────────────────────

interface ProductRow {
  code: string;
  name: string;
  group: string;
  unitOfMeasure: string;
  status: string;
  supplierId: string;
  supplierName: string;
  totalSOH: number;
  warehouseSOH: Record<string, number>;
  reorderPoint: number;
  reorderQuantity: number;
  openAssemblies: number;
  isIntermediate: boolean;
  equipment: string;
  batchSize: number;
  level: string;
  requires: string[];
  isLabel: boolean;
  isFG: boolean;
  planningWarehouse: WarehouseAssignment;
}

type SortKey = 'code' | 'name' | 'group' | 'soh' | 'supplier' | 'status' | 'warehouse';
type TabKey = 'all' | 'intermediates' | 'components' | 'fg' | 'labels' | 'suppliers';

// ─── Page ───────────────────────────────────────────────────

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [sohItems, setSOHItems] = useState<StockOnHandItem[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [assemblies, setAssemblies] = useState<Assembly[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('code');
  const [sortAsc, setSortAsc] = useState(true);
  const [tab, setTab] = useState<TabKey>('all');
  const [assignmentVersion, setAssignmentVersion] = useState(0); // bump to re-compute after override
  /**
   * Priority toggles write to localStorage synchronously; to re-render the
   * table after a toggle, we bump this version (same pattern as
   * `assignmentVersion`).
   */
  const [priorityVersion, setPriorityVersion] = useState(0);

  const handlePriorityToggle = useCallback((code: string, enabled: boolean) => {
    setPriority(code, enabled);
    setPriorityVersion(v => v + 1);
  }, []);

  // Fetch data
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/products-data');
        const json = await res.json();
        if (cancelled) return;
        if (json.success && json.data) {
          setProducts(json.data.products || []);
          setSOHItems(json.data.sohItems || []);
          setSuppliers(json.data.suppliers || []);
          setAssemblies(json.data.assemblies || []);
          setWarehouses(json.data.warehouses || []);
        } else {
          setError(json.error || 'Failed to load');
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Network error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // Aggregate SOH by product code
  const sohMap = useMemo(() => {
    const map: Record<string, { total: number; warehouses: Record<string, number> }> = {};
    for (const item of sohItems) {
      if (!map[item.productCode]) map[item.productCode] = { total: 0, warehouses: {} };
      map[item.productCode].total += item.quantity;
      map[item.productCode].warehouses[item.warehouseName] =
        (map[item.productCode].warehouses[item.warehouseName] || 0) + item.quantity;
    }
    return map;
  }, [sohItems]);

  // Per-product warehouse SOH for assignment computation
  const perProductWarehouseSOH = useMemo(() => {
    const map: Record<string, Record<string, number>> = {};
    for (const item of sohItems) {
      if (!map[item.productCode]) map[item.productCode] = {};
      map[item.productCode][item.warehouseName] =
        (map[item.productCode][item.warehouseName] || 0) + item.quantity;
    }
    return map;
  }, [sohItems]);

  // Warehouse assignment map (auto-assigned + overrides)
  const assignmentMap = useMemo(() => {
    const codes = new Set<string>();
    for (const p of products) codes.add(p.productCode);
    for (const item of sohItems) codes.add(item.productCode);
    return buildAssignmentMap(Array.from(codes), perProductWarehouseSOH);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, sohItems, perProductWarehouseSOH, assignmentVersion]);

  // Handle warehouse assignment change
  const handleWarehouseChange = useCallback((code: string, newWarehouse: string | null) => {
    if (newWarehouse === null) {
      removeOverride(code);
    } else {
      saveOverride(code, newWarehouse);
    }
    setAssignmentVersion(v => v + 1);
  }, []);

  // Assembly count by product code
  const assemblyCountMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const a of assemblies) {
      map[a.productCode] = (map[a.productCode] || 0) + 1;
    }
    return map;
  }, [assemblies]);

  // Supplier map
  const supplierMap = useMemo(() => {
    const map: Record<string, Supplier> = {};
    for (const s of suppliers) map[s.supplierId] = s;
    return map;
  }, [suppliers]);

  // Unique warehouses
  const warehouseNames = useMemo(() => {
    const names = new Set<string>();
    for (const item of sohItems) names.add(item.warehouseName);
    return Array.from(names).sort();
  }, [sohItems]);

  // Unique product groups
  const productGroups = useMemo(() => {
    const groups = new Set<string>();
    for (const p of products) if (p.productGroup) groups.add(p.productGroup);
    return Array.from(groups).sort();
  }, [products]);

  // Build product rows
  const rows = useMemo((): ProductRow[] => {
    // Start from SOH items (which includes all products with stock)
    // and merge with products list
    const codeSet = new Set<string>();
    for (const p of products) codeSet.add(p.productCode);
    for (const item of sohItems) codeSet.add(item.productCode);

    return Array.from(codeSet).map(code => {
      const product = products.find(p => p.productCode === code);
      const soh = sohMap[code] || { total: 0, warehouses: {} };
      const reg = INTERMEDIATE_REGISTRY[code];
      const isLabel = code.startsWith('L') && code.length > 1;
      // FG = has a label counterpart or starts with MF
      const isFG = !reg && !isLabel && (code.startsWith('MF') || code.startsWith('BF'));

      return {
        code,
        name: product?.productDescription || product?.productName || sohItems.find(s => s.productCode === code)?.productName || code,
        group: product?.productGroup || '',
        unitOfMeasure: product?.unitOfMeasure || '',
        status: product?.productStatus || (soh.total > 0 ? 'Active' : ''),
        supplierId: product?.supplier?.supplierId || '',
        supplierName: product?.supplier?.supplierName || '',
        totalSOH: soh.total,
        warehouseSOH: soh.warehouses,
        reorderPoint: product?.reorderPoint || 0,
        reorderQuantity: product?.reorderQuantity || 0,
        openAssemblies: assemblyCountMap[code] || 0,
        isIntermediate: !!reg,
        equipment: reg?.equipment || '',
        batchSize: reg?.batchSize || 0,
        level: reg?.level || '',
        requires: reg?.requires || [],
        isLabel,
        isFG,
        planningWarehouse: assignmentMap[code] || { warehouseName: '', isOverride: false, autoReason: '' },
      };
    });
  }, [products, sohItems, sohMap, assemblyCountMap, assignmentMap]);

  // Filter by tab + search
  const filtered = useMemo(() => {
    let result = rows;
    if (tab === 'intermediates') result = result.filter(r => r.isIntermediate);
    else if (tab === 'components') result = result.filter(r => !r.isIntermediate && !r.isLabel && !r.isFG);
    else if (tab === 'fg') result = result.filter(r => r.isFG);
    else if (tab === 'labels') result = result.filter(r => r.isLabel);

    if (search) {
      const q = search.toLowerCase();
      result = result.filter(r =>
        r.code.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        r.supplierName.toLowerCase().includes(q) ||
        r.group.toLowerCase().includes(q)
      );
    }
    return result;
  }, [rows, tab, search]);

  // Sort
  const sorted = useMemo(() => {
    const list = [...filtered];
    list.sort((a, b) => {
      let c = 0;
      if (sortKey === 'code') c = a.code.localeCompare(b.code);
      else if (sortKey === 'name') c = a.name.localeCompare(b.name);
      else if (sortKey === 'group') c = a.group.localeCompare(b.group);
      else if (sortKey === 'soh') c = a.totalSOH - b.totalSOH;
      else if (sortKey === 'supplier') c = a.supplierName.localeCompare(b.supplierName);
      else if (sortKey === 'status') c = a.status.localeCompare(b.status);
      else if (sortKey === 'warehouse') c = a.planningWarehouse.warehouseName.localeCompare(b.planningWarehouse.warehouseName);
      return sortAsc ? c : -c;
    });
    return list;
  }, [filtered, sortKey, sortAsc]);

  const toggleSort = useCallback((key: SortKey) => {
    if (sortKey === key) setSortAsc(p => !p);
    else { setSortKey(key); setSortAsc(true); }
  }, [sortKey]);

  const SortIcon = ({ k }: { k: SortKey }) => (
    <span className="ml-0.5 opacity-50">{sortKey === k ? (sortAsc ? '\u25B2' : '\u25BC') : ''}</span>
  );

  // Tab counts
  const counts = useMemo(() => ({
    all: rows.length,
    intermediates: rows.filter(r => r.isIntermediate).length,
    components: rows.filter(r => !r.isIntermediate && !r.isLabel && !r.isFG).length,
    fg: rows.filter(r => r.isFG).length,
    labels: rows.filter(r => r.isLabel).length,
    suppliers: suppliers.length,
  }), [rows, suppliers]);

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center" style={{ background: 'var(--bg-page)' }}>
        <div className="text-center">
          <div className="text-sm mb-2" style={{ color: 'var(--text-muted)' }}>Loading product data...</div>
          <div className="w-48 h-0.5 rounded overflow-hidden" style={{ background: 'var(--bg-surface)' }}>
            <div className="h-full rounded animate-pulse" style={{ width: '60%', background: 'var(--accent)' }} />
          </div>
        </div>
      </div>
    );
  }

  // Suppliers tab
  if (tab === 'suppliers') {
    return (
      <div className="h-screen flex flex-col overflow-hidden" style={{ background: 'var(--bg-page)', color: 'var(--text-primary)' }}>
        <PageHeader
          search={search} setSearch={setSearch}
          tab={tab} setTab={setTab}
          counts={counts} error={error}
          sorted={[]} suppliers={suppliers}
        />
        <div className="flex-1 overflow-auto">
          <table className="text-xs w-full" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
            <thead className="sticky top-0 z-10">
              <tr>
                {['Code', 'Name', 'Status', 'Contact', 'Email', 'Phone'].map(h => (
                  <th key={h} className="px-3 py-2 text-left" style={{ fontWeight: 600, fontSize: '11px', color: 'var(--text-secondary)', background: 'var(--bg-surface)', borderBottom: '0.5px solid var(--border)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {suppliers
                .filter(s => !search || s.supplierName.toLowerCase().includes(search.toLowerCase()) || s.supplierCode.toLowerCase().includes(search.toLowerCase()))
                .sort((a, b) => a.supplierName.localeCompare(b.supplierName))
                .map(s => (
                <tr key={s.supplierId} style={{ borderBottom: '0.5px solid var(--border)' }}
                  className="transition"
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-surface)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = ''; }}
                >
                  <td className="px-3 py-2 font-mono" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{s.supplierCode}</td>
                  <td className="px-3 py-2" style={{ color: 'var(--text-primary)' }}>{s.supplierName}</td>
                  <td className="px-3 py-2">
                    <span className="px-1.5 py-0.5 rounded text-[10px]" style={{
                      fontWeight: 500,
                      color: s.supplierStatus === 'Active' ? 'var(--success)' : 'var(--text-muted)',
                      background: s.supplierStatus === 'Active' ? 'rgba(21,128,61,0.12)' : 'var(--bg-surface)',
                    }}>
                      {s.supplierStatus}
                    </span>
                  </td>
                  <td className="px-3 py-2" style={{ color: 'var(--text-secondary)' }}>{s.contactName || '\u2014'}</td>
                  <td className="px-3 py-2" style={{ color: 'var(--text-secondary)' }}>{s.email || '\u2014'}</td>
                  <td className="px-3 py-2" style={{ color: 'var(--text-secondary)' }}>{s.phone || '\u2014'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: 'var(--bg-page)', color: 'var(--text-primary)' }}>
      <PageHeader
        search={search} setSearch={setSearch}
        tab={tab} setTab={setTab}
        counts={counts} error={error}
        sorted={sorted} suppliers={suppliers}
      />

      {/* Product table */}
      <div className="flex-1 overflow-auto">
        <table className="text-xs w-full" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead className="sticky top-0 z-10">
            <tr>
              <SortHeader k="code" label="Code" sortKey={sortKey} sortAsc={sortAsc} onClick={toggleSort} />
              <SortHeader k="name" label="Name" sortKey={sortKey} sortAsc={sortAsc} onClick={toggleSort} />
              <SortHeader k="group" label="Group" sortKey={sortKey} sortAsc={sortAsc} onClick={toggleSort} />
              <SortHeader k="status" label="Status" sortKey={sortKey} sortAsc={sortAsc} onClick={toggleSort} />
              <SortHeader k="supplier" label="Supplier" sortKey={sortKey} sortAsc={sortAsc} onClick={toggleSort} />
              <SortHeader k="warehouse" label="Planning WH" sortKey={sortKey} sortAsc={sortAsc} onClick={toggleSort} />
              <SortHeader k="soh" label="SOH" sortKey={sortKey} sortAsc={sortAsc} onClick={toggleSort} align="right" />
              {warehouseNames.map(w => (
                <th key={w} className="px-2 py-2 text-right" style={{ fontWeight: 500, fontSize: '10px', color: 'var(--text-muted)', background: 'var(--bg-surface)', borderBottom: '0.5px solid var(--border)', whiteSpace: 'nowrap' }}>
                  {w}
                </th>
              ))}
              <th className="px-2 py-2 text-right" style={{ fontWeight: 600, fontSize: '11px', color: 'var(--text-secondary)', background: 'var(--bg-surface)', borderBottom: '0.5px solid var(--border)' }}>
                UoM
              </th>
              <th className="px-2 py-2 text-right" style={{ fontWeight: 600, fontSize: '11px', color: 'var(--text-secondary)', background: 'var(--bg-surface)', borderBottom: '0.5px solid var(--border)' }}>
                Reorder Pt
              </th>
              {tab === 'fg' && (
                <th
                  className="px-2 py-2 text-center"
                  style={{ fontWeight: 600, fontSize: '11px', color: 'var(--text-secondary)', background: 'var(--bg-surface)', borderBottom: '0.5px solid var(--border)' }}
                  title="Enable priority-mode — negative availability on this product will surface on the Priorities page"
                >
                  Priority
                </th>
              )}
              {tab === 'intermediates' && (
                <>
                  <th className="px-2 py-2 text-center" style={{ fontWeight: 600, fontSize: '11px', color: 'var(--text-secondary)', background: 'var(--bg-surface)', borderBottom: '0.5px solid var(--border)' }}>
                    Equipment
                  </th>
                  <th className="px-2 py-2 text-right" style={{ fontWeight: 600, fontSize: '11px', color: 'var(--text-secondary)', background: 'var(--bg-surface)', borderBottom: '0.5px solid var(--border)' }}>
                    Batch (kg)
                  </th>
                  <th className="px-2 py-2 text-center" style={{ fontWeight: 600, fontSize: '11px', color: 'var(--text-secondary)', background: 'var(--bg-surface)', borderBottom: '0.5px solid var(--border)' }}>
                    Level
                  </th>
                  <th className="px-2 py-2 text-left" style={{ fontWeight: 600, fontSize: '11px', color: 'var(--text-secondary)', background: 'var(--bg-surface)', borderBottom: '0.5px solid var(--border)' }}>
                    Requires
                  </th>
                </>
              )}
              <th className="px-2 py-2 text-right" style={{ fontWeight: 600, fontSize: '11px', color: 'var(--text-secondary)', background: 'var(--bg-surface)', borderBottom: '0.5px solid var(--border)' }}>
                Assemblies
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(row => (
              <tr
                key={row.code}
                style={{ borderBottom: '0.5px solid var(--border)' }}
                className="transition"
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-surface)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = ''; }}
              >
                <td className="px-3 py-1.5 font-mono" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                  {row.code}
                  {row.isIntermediate && (
                    <span className="ml-1 px-1 rounded text-[9px]" style={{ background: 'var(--accent-light)', color: 'var(--accent)', fontWeight: 500 }}>INT</span>
                  )}
                  {row.isLabel && (
                    <span className="ml-1 px-1 rounded text-[9px]" style={{ background: 'rgba(168,85,247,0.15)', color: 'rgb(168,85,247)', fontWeight: 500 }}>LBL</span>
                  )}
                </td>
                <td className="px-3 py-1.5 truncate" style={{ color: 'var(--text-secondary)', maxWidth: 280 }} title={row.name}>
                  {row.name}
                </td>
                <td className="px-3 py-1.5 truncate" style={{ color: 'var(--text-muted)', maxWidth: 140 }}>
                  {row.group || '\u2014'}
                </td>
                <td className="px-3 py-1.5">
                  <span className="px-1.5 py-0.5 rounded text-[10px]" style={{
                    fontWeight: 500,
                    color: row.status === 'Active' ? 'var(--success)' : row.status === 'Discontinued' ? 'var(--danger)' : 'var(--text-muted)',
                    background: row.status === 'Active' ? 'rgba(21,128,61,0.12)' : row.status === 'Discontinued' ? 'rgba(185,28,28,0.12)' : 'var(--bg-surface)',
                  }}>
                    {row.status || '\u2014'}
                  </span>
                </td>
                <td className="px-3 py-1.5 truncate" style={{ color: 'var(--text-secondary)', maxWidth: 160 }}>
                  {row.supplierName || '\u2014'}
                </td>
                <td className="px-2 py-0.5" style={{ minWidth: 130 }}>
                  <WarehouseDropdown
                    value={row.planningWarehouse.warehouseName}
                    isOverride={row.planningWarehouse.isOverride}
                    autoReason={row.planningWarehouse.autoReason}
                    warehouses={warehouses}
                    onChange={(wh) => handleWarehouseChange(row.code, wh)}
                    onReset={() => handleWarehouseChange(row.code, null)}
                  />
                </td>
                <td className="px-3 py-1.5 text-right font-mono" style={{
                  fontWeight: 500,
                  color: row.totalSOH > 0 ? 'var(--text-primary)' : 'var(--text-muted)',
                }}>
                  {row.totalSOH > 0 ? Math.round(row.totalSOH) : '\u2014'}
                </td>
                {warehouseNames.map(w => (
                  <td key={w} className="px-2 py-1.5 text-right font-mono" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                    {row.warehouseSOH[w] ? Math.round(row.warehouseSOH[w]) : ''}
                  </td>
                ))}
                <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>
                  {row.unitOfMeasure || '\u2014'}
                </td>
                <td className="px-2 py-1.5 text-right font-mono" style={{ color: row.reorderPoint > 0 ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                  {row.reorderPoint > 0 ? row.reorderPoint : '\u2014'}
                </td>
                {tab === 'fg' && (() => {
                  // priorityVersion is read to force re-render after toggle.
                  void priorityVersion;
                  const enabled = isPriority(row.code);
                  return (
                    <td className="px-2 py-1.5 text-center">
                      <button
                        type="button"
                        onClick={() => handlePriorityToggle(row.code, !enabled)}
                        className="inline-flex items-center justify-center w-5 h-5 rounded transition cursor-pointer"
                        style={{
                          border: `0.5px solid ${enabled ? 'var(--accent)' : 'var(--border)'}`,
                          background: enabled ? 'var(--accent-light)' : 'var(--bg-surface)',
                          color: enabled ? 'var(--accent)' : 'transparent',
                          fontWeight: 600,
                          fontSize: 11,
                          lineHeight: 1,
                        }}
                        title={enabled ? 'Priority enabled — click to disable' : 'Enable priority for this product'}
                        aria-label={`Priority mode for ${row.code}`}
                        aria-pressed={enabled}
                      >
                        {enabled ? 'PR' : ''}
                      </button>
                    </td>
                  );
                })()}
                {tab === 'intermediates' && (
                  <>
                    <td className="px-2 py-1.5 text-center">
                      {row.equipment ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]" style={{ fontWeight: 500, color: 'var(--text-secondary)', background: 'var(--bg-surface)' }}>
                          <span className="w-2 h-2 rounded-full" style={{ background: EQUIPMENT_COLORS[row.equipment as keyof typeof EQUIPMENT_COLORS]?.bg || 'var(--text-muted)' }} />
                          {row.equipment}
                        </span>
                      ) : '\u2014'}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono" style={{ color: 'var(--text-secondary)' }}>
                      {row.batchSize || '\u2014'}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <span className="px-1.5 py-0.5 rounded text-[10px]" style={{
                        fontWeight: 500,
                        color: row.level === 'secondary' ? 'var(--warning)' : 'var(--text-secondary)',
                        background: row.level === 'secondary' ? 'rgba(180,83,9,0.12)' : 'var(--bg-surface)',
                      }}>
                        {row.level || '\u2014'}
                      </span>
                    </td>
                    <td className="px-2 py-1.5" style={{ color: 'var(--text-muted)' }}>
                      {row.requires.length > 0 ? row.requires.join(', ') : '\u2014'}
                    </td>
                  </>
                )}
                <td className="px-2 py-1.5 text-right font-mono" style={{ color: row.openAssemblies > 0 ? 'var(--accent)' : 'var(--text-muted)' }}>
                  {row.openAssemblies > 0 ? row.openAssemblies : '\u2014'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────

function PageHeader({
  search, setSearch, tab, setTab, counts, error, sorted, suppliers,
}: {
  search: string;
  setSearch: (s: string) => void;
  tab: TabKey;
  setTab: (t: TabKey) => void;
  counts: Record<TabKey, number>;
  error: string | null;
  sorted: ProductRow[];
  suppliers: Supplier[];
}) {
  const displayCount = tab === 'suppliers' ? suppliers.filter(s =>
    !search || s.supplierName.toLowerCase().includes(search.toLowerCase()) || s.supplierCode.toLowerCase().includes(search.toLowerCase())
  ).length : sorted.length;

  return (
    <>
      {error && (
        <div className="px-6 py-2 text-sm" style={{ background: 'var(--danger-light)', color: 'var(--danger)', borderBottom: '0.5px solid var(--border)' }}>
          {error}
        </div>
      )}
      <div className="px-6 pt-5 pb-4" style={{ borderBottom: '0.5px solid var(--border)' }}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>Products & Attributes</h1>
            <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
              All products, components, intermediates, and suppliers from Unleashed
            </p>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-6 gap-3 mb-4">
          {([
            { key: 'all' as TabKey, label: 'All Products', value: counts.all },
            { key: 'intermediates' as TabKey, label: 'Intermediates', value: counts.intermediates, color: 'var(--accent)' },
            { key: 'components' as TabKey, label: 'Components', value: counts.components },
            { key: 'fg' as TabKey, label: 'Finished Goods', value: counts.fg, color: 'var(--success)' },
            { key: 'labels' as TabKey, label: 'Labels', value: counts.labels, color: 'rgb(168,85,247)' },
            { key: 'suppliers' as TabKey, label: 'Suppliers', value: counts.suppliers, color: 'var(--warning)' },
          ]).map(card => (
            <button
              key={card.key}
              onClick={() => setTab(card.key)}
              className="rounded px-3 py-2 text-left transition"
              style={{
                background: tab === card.key ? 'var(--accent-light)' : 'var(--bg-surface)',
                border: tab === card.key ? '0.5px solid var(--accent)' : '0.5px solid transparent',
              }}
            >
              <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>{card.label}</div>
              <div className="text-xl mt-0.5" style={{ fontWeight: 500, color: card.color || 'var(--text-primary)' }}>{card.value}</div>
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="flex items-center gap-3">
          <input
            type="text"
            placeholder="Search by code, name, supplier, or group..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="rounded px-3 py-1.5 text-xs w-80 focus:outline-none"
            style={{ color: 'var(--text-primary)', background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }}
          />
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {displayCount} {tab === 'suppliers' ? 'supplier' : 'product'}{displayCount !== 1 ? 's' : ''}
          </span>
        </div>
      </div>
    </>
  );
}

function SortHeader({ k, label, sortKey, sortAsc, onClick, align }: {
  k: SortKey;
  label: string;
  sortKey: SortKey;
  sortAsc: boolean;
  onClick: (k: SortKey) => void;
  align?: 'right';
}) {
  return (
    <th
      className={`px-3 py-2 cursor-pointer select-none hover:opacity-70 transition ${align === 'right' ? 'text-right' : 'text-left'}`}
      style={{ fontWeight: 600, fontSize: '11px', color: sortKey === k ? 'var(--accent)' : 'var(--text-secondary)', background: 'var(--bg-surface)', borderBottom: '0.5px solid var(--border)' }}
      onClick={() => onClick(k)}
    >
      {label}
      <span className="ml-0.5 opacity-50">{sortKey === k ? (sortAsc ? '\u25B2' : '\u25BC') : ''}</span>
    </th>
  );
}

/** Warehouse abbreviations for compact display */
const WH_SHORT: Record<string, string> = {
  'Lundberg Storeroom': 'Lundberg',
  'MF Packaging': 'MF Pkg',
  'MF Operations': 'MF Ops',
  'TBC': 'TBC',
  'TBC Height': 'TBC Hgt',
};

function WarehouseDropdown({
  value,
  isOverride,
  autoReason,
  warehouses,
  onChange,
  onReset,
}: {
  value: string;
  isOverride: boolean;
  autoReason: string;
  warehouses: Warehouse[];
  onChange: (wh: string) => void;
  onReset: () => void;
}) {
  return (
    <div className="flex items-center gap-1 group">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        title={isOverride ? `Override — click × to revert to auto: ${autoReason || 'auto'}` : autoReason}
        className="rounded px-1.5 py-0.5 text-[10px] focus:outline-none cursor-pointer appearance-none"
        style={{
          fontWeight: isOverride ? 600 : 400,
          color: isOverride ? 'var(--accent)' : 'var(--text-secondary)',
          background: isOverride ? 'var(--accent-light)' : 'transparent',
          border: isOverride ? '0.5px solid var(--accent)' : '0.5px solid transparent',
          maxWidth: 90,
        }}
      >
        {warehouses.map(w => (
          <option key={w.warehouseId} value={w.warehouseName}>
            {WH_SHORT[w.warehouseName] || w.warehouseName}
          </option>
        ))}
      </select>
      {isOverride && (
        <button
          onClick={(e) => { e.stopPropagation(); onReset(); }}
          className="opacity-0 group-hover:opacity-100 transition text-[10px]"
          style={{ color: 'var(--text-muted)' }}
          title="Reset to auto-assignment"
        >
          ×
        </button>
      )}
    </div>
  );
}
