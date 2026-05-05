'use client';

import { useState, useMemo } from 'react';
import type { SupplierInfo } from '../data/mock-purchasing-data';
import type { ComponentStatus } from '../hooks/usePurchasingPlanner';

interface ComponentSidebarProps {
  componentSOH: Record<string, number>;
  componentNames: Record<string, string>;
  componentSuppliers: Record<string, string>;
  suppliers: Record<string, SupplierInfo>;
  componentStatusMap: Map<string, ComponentStatus>;
  selectedComponent: string | null;
  onSelect: (code: string) => void;
}

const STATUS_COLORS: Record<ComponentStatus, string> = {
  ok: 'var(--success)',
  low: 'var(--warning)',
  stockout: 'var(--danger)',
};

export function ComponentSidebar({
  componentSOH,
  componentNames,
  componentSuppliers,
  suppliers,
  componentStatusMap,
  selectedComponent,
  onSelect,
}: ComponentSidebarProps) {
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Group components by supplier
  const supplierGroups = useMemo(() => {
    const groups: Record<string, string[]> = {};
    const unassigned: string[] = [];

    for (const code of Object.keys(componentSOH)) {
      const supplierId = componentSuppliers[code];
      if (supplierId && suppliers[supplierId]) {
        if (!groups[supplierId]) groups[supplierId] = [];
        groups[supplierId].push(code);
      } else {
        unassigned.push(code);
      }
    }

    // Sort components within each group by name
    for (const codes of Object.values(groups)) {
      codes.sort((a, b) => (componentNames[a] || a).localeCompare(componentNames[b] || b));
    }
    unassigned.sort((a, b) => (componentNames[a] || a).localeCompare(componentNames[b] || b));

    return { groups, unassigned };
  }, [componentSOH, componentSuppliers, suppliers, componentNames]);

  // Filter by search
  const matchesSearch = (code: string) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      code.toLowerCase().includes(q) ||
      (componentNames[code] || '').toLowerCase().includes(q)
    );
  };

  const toggleCollapse = (supplierId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(supplierId)) next.delete(supplierId);
      else next.add(supplierId);
      return next;
    });
  };

  const renderRow = (code: string) => {
    if (!matchesSearch(code)) return null;
    const status = componentStatusMap.get(code) || 'ok';
    const isSelected = selectedComponent === code;

    return (
      <button
        key={code}
        onClick={() => onSelect(code)}
        className="w-full text-left px-3 py-2 rounded text-sm transition"
        style={{
          background: isSelected ? 'var(--accent-light)' : 'transparent',
          border: isSelected ? '0.5px solid var(--accent)' : '0.5px solid transparent',
        }}
        onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'var(--bg-hover)'; }}
        onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <div
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ background: STATUS_COLORS[status] }}
            />
            <span className="truncate" style={{ color: 'var(--text-primary)' }}>
              {componentNames[code] || code}
            </span>
          </div>
          <span className="text-xs flex-shrink-0 ml-2" style={{ color: 'var(--text-muted)' }}>
            {Math.round(componentSOH[code] || 0)}
          </span>
        </div>
        <div className="text-xs ml-4" style={{ color: 'var(--text-muted)' }}>{code}</div>
      </button>
    );
  };

  const renderGroup = (supplierId: string, codes: string[]) => {
    const supplier = suppliers[supplierId];
    const filteredCodes = codes.filter(matchesSearch);
    if (filteredCodes.length === 0) return null;
    const isCollapsed = collapsed.has(supplierId);

    // Count statuses for group header
    let worstStatus: ComponentStatus = 'ok';
    for (const code of filteredCodes) {
      const s = componentStatusMap.get(code) || 'ok';
      if (s === 'stockout') { worstStatus = 'stockout'; break; }
      if (s === 'low') worstStatus = 'low';
    }

    return (
      <div key={supplierId} className="mb-2">
        <button
          onClick={() => toggleCollapse(supplierId)}
          className="w-full flex items-center justify-between px-3 py-2 text-xs transition hover:opacity-70"
          style={{ fontWeight: 500, color: 'var(--text-secondary)' }}
        >
          <div className="flex items-center gap-2">
            <span style={{ color: 'var(--text-muted)' }}>{isCollapsed ? '\u25B8' : '\u25BE'}</span>
            <div
              className="w-2 h-2 rounded-full"
              style={{ background: STATUS_COLORS[worstStatus] }}
            />
            <span className="uppercase tracking-wide">
              {supplier?.supplierName || supplierId}
            </span>
          </div>
          <span style={{ color: 'var(--text-muted)' }}>{filteredCodes.length}</span>
        </button>
        {!isCollapsed && (
          <div className="ml-2 space-y-0.5">{filteredCodes.map(renderRow)}</div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="p-3" style={{ borderBottom: '0.5px solid var(--border)' }}>
        <h2 className="text-sm mb-2" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>Components</h2>
        <input
          type="text"
          placeholder="Search..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded px-3 py-1.5 text-sm placeholder:opacity-40 focus:outline-none transition"
          style={{
            color: 'var(--text-primary)',
            background: 'var(--bg-surface)',
            border: '0.5px solid var(--border)',
          }}
        />
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {Object.entries(supplierGroups.groups).map(([supplierId, codes]) =>
          renderGroup(supplierId, codes)
        )}
        {supplierGroups.unassigned.length > 0 &&
          renderGroup('unassigned', supplierGroups.unassigned)}
      </div>
    </div>
  );
}
