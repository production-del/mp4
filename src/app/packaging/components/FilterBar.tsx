'use client';

import { useMemo } from 'react';
import type { ProductFamily } from '../hooks/usePackagingData';

interface FilterBarProps {
  families: ProductFamily[];
  search: string;
  onSearchChange: (s: string) => void;
  selectedGroups: Set<string>;
  onToggleGroup: (group: string) => void;
  viewMode: 'family' | 'sku';
  onSetViewMode: (mode: 'family' | 'sku') => void;
  allCollapsed: boolean;
  onToggleCollapseAll: () => void;
}

export function FilterBar({
  families,
  search,
  onSearchChange,
  selectedGroups,
  onToggleGroup,
  viewMode,
  onSetViewMode,
  allCollapsed,
  onToggleCollapseAll,
}: FilterBarProps) {
  const groups = useMemo(() => {
    const set = new Set<string>();
    for (const family of families) {
      for (const sku of family.skus) {
        if (sku.productGroup) set.add(sku.productGroup);
      }
    }
    return [...set].sort();
  }, [families]);

  return (
    <div
      className="flex items-center gap-3 px-6 py-3 overflow-x-auto"
      style={{ borderBottom: '0.5px solid var(--border)' }}
    >
      <input
        type="text"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Search SKU or product name..."
        className="w-56 px-2.5 py-1 rounded text-sm placeholder:opacity-40 focus:outline-none transition flex-shrink-0"
        style={{
          color: 'var(--text-primary)',
          background: 'var(--bg-surface)',
          border: '0.5px solid var(--border)',
        }}
      />

      <div className="flex items-center gap-1.5 flex-wrap">
        {groups.map((group) => {
          const active = selectedGroups.has(group);
          return (
            <button
              key={group}
              onClick={() => onToggleGroup(group)}
              className="px-2 py-0.5 rounded text-sm transition whitespace-nowrap"
              style={{
                fontWeight: active ? 500 : 400,
                color: active ? 'var(--accent)' : 'var(--text-muted)',
                background: active ? 'var(--accent-light)' : 'transparent',
                border: `0.5px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
              }}
            >
              {group.replace('MF - ', '')}
            </button>
          );
        })}
      </div>

      <div className="ml-auto flex-shrink-0 flex items-center gap-2">
        <div
          className="flex rounded overflow-hidden"
          style={{ border: '0.5px solid var(--border)' }}
        >
          {(['family', 'sku'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => onSetViewMode(mode)}
              className="px-2.5 py-1 text-sm transition"
              style={{
                fontWeight: viewMode === mode ? 500 : 400,
                color: viewMode === mode ? 'var(--accent)' : 'var(--text-muted)',
                background: viewMode === mode ? 'var(--accent-light)' : 'transparent',
              }}
            >
              {mode === 'family' ? 'Family' : 'SKU'}
            </button>
          ))}
        </div>
        {viewMode === 'family' && (
          <button
            onClick={onToggleCollapseAll}
            className="px-2.5 py-1 rounded text-sm transition hover:opacity-70"
            style={{ color: 'var(--text-secondary)', fontWeight: 400 }}
          >
            {allCollapsed ? 'Expand All' : 'Collapse All'}
          </button>
        )}
      </div>
    </div>
  );
}
