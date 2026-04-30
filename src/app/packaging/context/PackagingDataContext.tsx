'use client';

import { createContext, useContext } from 'react';
import type { PackagingSKU, ProductFamily } from '../hooks/usePackagingData';

interface PackagingDataContextValue {
  skus: PackagingSKU[];
  families: ProductFamily[];
  sohMap: Record<string, number>;
  loading: boolean;
}

export const PackagingDataContext = createContext<PackagingDataContextValue>({
  skus: [],
  families: [],
  sohMap: {},
  loading: true,
});

export function usePackagingDataContext() {
  return useContext(PackagingDataContext);
}
