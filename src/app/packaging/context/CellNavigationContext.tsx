'use client';

import { createContext, useContext, useState, useCallback, useRef } from 'react';

export interface CellCoord {
  familyCode: string;
  rowIndex: number;
  colIndex: number; // 0=ExistingQty, 1=ExistingDay, 2=Qty, 3=Day
}

const EDITABLE_COLS = 4; // ExistingQty, ExistingDay, Qty, Day

interface CellNavigationContextValue {
  activeCell: CellCoord | null;
  setActiveCell: (coord: CellCoord | null) => void;
  moveToNext: (from: CellCoord, direction: 'right' | 'left' | 'down' | 'up') => void;
  registerFamily: (familyCode: string, rowCount: number) => void;
  unregisterFamily: (familyCode: string) => void;
}

const CellNavigationContext = createContext<CellNavigationContextValue>({
  activeCell: null,
  setActiveCell: () => {},
  moveToNext: () => {},
  registerFamily: () => {},
  unregisterFamily: () => {},
});

export function useCellNavigation() {
  return useContext(CellNavigationContext);
}

export function CellNavigationProvider({ children, familyOrder }: {
  children: React.ReactNode;
  familyOrder: string[];
}) {
  const [activeCell, setActiveCell] = useState<CellCoord | null>(null);
  const familyRowCounts = useRef<Map<string, number>>(new Map());

  const registerFamily = useCallback((familyCode: string, rowCount: number) => {
    familyRowCounts.current.set(familyCode, rowCount);
  }, []);

  const unregisterFamily = useCallback((familyCode: string) => {
    familyRowCounts.current.delete(familyCode);
  }, []);

  const moveToNext = useCallback(
    (from: CellCoord, direction: 'right' | 'left' | 'down' | 'up') => {
      const rowCount = familyRowCounts.current.get(from.familyCode) ?? 0;
      // Find this family's position in the ordered list
      const famIdx = familyOrder.indexOf(from.familyCode);

      let next: CellCoord | null = null;

      if (direction === 'right') {
        if (from.colIndex < EDITABLE_COLS - 1) {
          next = { ...from, colIndex: from.colIndex + 1 };
        } else if (from.rowIndex < rowCount - 1) {
          next = { ...from, rowIndex: from.rowIndex + 1, colIndex: 0 };
        } else {
          // Next family
          for (let i = famIdx + 1; i < familyOrder.length; i++) {
            const fc = familyOrder[i];
            if (familyRowCounts.current.has(fc)) {
              next = { familyCode: fc, rowIndex: 0, colIndex: 0 };
              break;
            }
          }
        }
      } else if (direction === 'left') {
        if (from.colIndex > 0) {
          next = { ...from, colIndex: from.colIndex - 1 };
        } else if (from.rowIndex > 0) {
          next = { ...from, rowIndex: from.rowIndex - 1, colIndex: EDITABLE_COLS - 1 };
        } else {
          // Previous family, last row last col
          for (let i = famIdx - 1; i >= 0; i--) {
            const fc = familyOrder[i];
            const rc = familyRowCounts.current.get(fc);
            if (rc != null) {
              next = { familyCode: fc, rowIndex: rc - 1, colIndex: EDITABLE_COLS - 1 };
              break;
            }
          }
        }
      } else if (direction === 'down') {
        if (from.rowIndex < rowCount - 1) {
          next = { ...from, rowIndex: from.rowIndex + 1 };
        } else {
          // Next family, same col
          for (let i = famIdx + 1; i < familyOrder.length; i++) {
            const fc = familyOrder[i];
            if (familyRowCounts.current.has(fc)) {
              next = { familyCode: fc, rowIndex: 0, colIndex: from.colIndex };
              break;
            }
          }
        }
      } else if (direction === 'up') {
        if (from.rowIndex > 0) {
          next = { ...from, rowIndex: from.rowIndex - 1 };
        } else {
          // Previous family, last row, same col
          for (let i = famIdx - 1; i >= 0; i--) {
            const fc = familyOrder[i];
            const rc = familyRowCounts.current.get(fc);
            if (rc != null) {
              next = { familyCode: fc, rowIndex: rc - 1, colIndex: from.colIndex };
              break;
            }
          }
        }
      }

      setActiveCell(next);
    },
    [familyOrder]
  );

  return (
    <CellNavigationContext.Provider
      value={{ activeCell, setActiveCell, moveToNext, registerFamily, unregisterFamily }}
    >
      {children}
    </CellNavigationContext.Provider>
  );
}
