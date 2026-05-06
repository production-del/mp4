'use client';

import { useState, useCallback, useEffect } from 'react';

// ─── Types ──────────────────────────────────────────────────

export interface PackagingSettings {
  targetDays: number;
  workingDaysPerMonth: number;
  warehouseId: string;
  warehouseName: string;
  fetchIntervals: {
    soh: number;       // minutes
    assemblies: number;
    boms: number;
  };
}

interface PackagingConfigState {
  settings: PackagingSettings;
  monthlyUsage: Record<string, number>; // productCode → units/month
  familyTargetDays: Record<string, number>; // familyCode → target days override
}

// ─── Defaults ───────────────────────────────────────────────

const DEFAULT_SETTINGS: PackagingSettings = {
  targetDays: 60,
  workingDaysPerMonth: 22,
  warehouseId: '',
  warehouseName: '',
  fetchIntervals: {
    soh: 5,
    assemblies: 5,
    boms: 30,
  },
};

const STORAGE_KEY = 'byron-packaging-config';

// ─── Hook ───────────────────────────────────────────────────

export function usePackagingConfig() {
  const [state, setState] = useState<PackagingConfigState>(() => {
    if (typeof window === 'undefined') {
      return { settings: DEFAULT_SETTINGS, monthlyUsage: {}, familyTargetDays: {} };
    }
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          settings: { ...DEFAULT_SETTINGS, ...parsed.settings },
          monthlyUsage: parsed.monthlyUsage || {},
          familyTargetDays: parsed.familyTargetDays || {},
        };
      }
    } catch {
      // ignore
    }
    return { settings: DEFAULT_SETTINGS, monthlyUsage: {}, familyTargetDays: {} };
  });

  // Persist to localStorage on changes
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore
    }
  }, [state]);

  const updateSettings = useCallback((patch: Partial<PackagingSettings>) => {
    setState(prev => ({
      ...prev,
      settings: { ...prev.settings, ...patch },
    }));
  }, []);

  const updateFetchIntervals = useCallback(
    (patch: Partial<PackagingSettings['fetchIntervals']>) => {
      setState(prev => ({
        ...prev,
        settings: {
          ...prev.settings,
          fetchIntervals: { ...prev.settings.fetchIntervals, ...patch },
        },
      }));
    },
    []
  );

  const setMonthlyUsage = useCallback((usage: Record<string, number>) => {
    setState(prev => ({
      ...prev,
      monthlyUsage: { ...prev.monthlyUsage, ...usage },
    }));
  }, []);

  const setMonthlyUsageSingle = useCallback(
    (productCode: string, value: number) => {
      setState(prev => ({
        ...prev,
        monthlyUsage: { ...prev.monthlyUsage, [productCode]: value },
      }));
    },
    []
  );

  const setFamilyTargetDays = useCallback(
    (familyCode: string, days: number) => {
      setState(prev => ({
        ...prev,
        familyTargetDays: { ...prev.familyTargetDays, [familyCode]: days },
      }));
    },
    []
  );

  const clearFamilyTargetDays = useCallback(
    (familyCode: string) => {
      setState(prev => {
        const next = { ...prev.familyTargetDays };
        delete next[familyCode];
        return { ...prev, familyTargetDays: next };
      });
    },
    []
  );

  const getTargetDaysForFamily = useCallback(
    (familyCode: string): number => {
      return state.familyTargetDays[familyCode] ?? state.settings.targetDays;
    },
    [state.familyTargetDays, state.settings.targetDays]
  );

  // Auto-fetch demand data from Google Sheet on mount
  const [demandLoading, setDemandLoading] = useState(false);
  const [demandError, setDemandError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadDemand() {
      setDemandLoading(true);
      try {
        // Client-side override (uploaded via Settings → Demand Import) wins
        // over the server CSV. If the operator clears the override, we fall
        // back to the server file automatically.
        const { readDemandOverride } = await import('@/lib/planning/demand-override');
        const override = readDemandOverride();
        if (override) {
          if (!cancelled) {
            setState(prev => ({
              ...prev,
              monthlyUsage: { ...prev.monthlyUsage, ...override.demand },
            }));
            setDemandError(null);
          }
          return;
        }

        const res = await fetch('/api/demand-data');
        const json = await res.json();
        if (json.success && json.data?.demand && !cancelled) {
          setState(prev => ({
            ...prev,
            monthlyUsage: { ...prev.monthlyUsage, ...json.data.demand },
          }));
          setDemandError(null);
        } else if (!json.success && !cancelled) {
          setDemandError(json.error || 'Failed to load demand');
        }
      } catch (err) {
        if (!cancelled) setDemandError(err instanceof Error ? err.message : 'Network error');
      } finally {
        if (!cancelled) setDemandLoading(false);
      }
    }
    loadDemand();

    // Reload when the operator imports/clears a demand override via Settings.
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'byron-demand-override-v1' || e.key === null) {
        loadDemand();
      }
    };
    window.addEventListener('storage', onStorage);

    return () => {
      cancelled = true;
      window.removeEventListener('storage', onStorage);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const resetToDefaults = useCallback(() => {
    setState({ settings: DEFAULT_SETTINGS, monthlyUsage: {}, familyTargetDays: {} });
  }, []);

  return {
    settings: state.settings,
    monthlyUsage: state.monthlyUsage,
    demandLoading,
    demandError,
    familyTargetDays: state.familyTargetDays,
    updateSettings,
    updateFetchIntervals,
    setMonthlyUsage,
    setMonthlyUsageSingle,
    setFamilyTargetDays,
    clearFamilyTargetDays,
    getTargetDaysForFamily,
    resetToDefaults,
  };
}
