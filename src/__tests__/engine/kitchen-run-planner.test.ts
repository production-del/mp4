import { planKitchenRuns } from '@/lib/engine/kitchen-run-planner';
import type { BOMComponent } from '@/lib/planning/engine-io';
import type { KitchenIntermediate } from '@/lib/planning/capacity-data';

// ─── Fixture helpers ─────────────────────────────────────────

function bomRow(parent: string, code: string, qty: number): BOMComponent {
  return {
    parentProductCode: parent,
    productCode: code,
    productName: code,
    quantityPerParent: qty,
    level: 1,
  };
}

function intermediate(
  productCode: string,
  productionHints: { soak?: boolean; cook?: boolean; dehydHours?: number } = {},
): KitchenIntermediate {
  const steps: string[] = [];
  if (productionHints.soak) steps.push('soak');
  steps.push('mix');
  if (productionHints.cook) steps.push('cook');
  if (productionHints.dehydHours) steps.push('dehydrate');
  return {
    productCode,
    productName: productCode,
    processSteps: steps,
    packingStation: null,
    alternateStation: null,
    maxSoakIbc: null,
    maxSoakTub: null,
    maxMixBowl: null,
    ovenCapacityPerDay: null,
    kgPerTray: null,
    dehydHours: productionHints.dehydHours ?? null,
    humidity: null,
  };
}

// ─── Tests ───────────────────────────────────────────────────

describe('planKitchenRuns', () => {
  describe('lead-time backoff (single level)', () => {
    test('1-day production: chip starts 1 day before requiredByDate (= finishes day before)', () => {
      // ICCC takes 1 day (just mixing, no soak/cook/dehydrate).
      // Required by 2026-05-15 (packaging). Buffer 1 day.
      // finish = 14, start = 14, available = 15.
      const runs = planKitchenRuns({
        packagingActivities: [
          { productCode: 'FCHOC', productName: 'Choc Clusters', quantity: 100, date: '2026-05-15' },
        ],
        bom: [bomRow('FCHOC', 'ICC', 0.5)],
        intermediates: new Map([['ICC', intermediate('ICC')]]),
        intermediateCodes: new Set(['ICC']),
        lundbergSohByCode: {},
        scheduledSupply: [],
      });
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        intermediateCode: 'ICC',
        durationDays: 1,
        startDate: '2026-05-14',
        finishDate: '2026-05-14',
        availableDate: '2026-05-15',
      });
    });

    test('2-day production (soak + dehydrate ≤24h): start 1 day before finish', () => {
      // Soak (1d) + dehydrate 18h (1d) = 2 days.
      const runs = planKitchenRuns({
        packagingActivities: [
          { productCode: 'FG', productName: 'X', quantity: 100, date: '2026-05-15' },
        ],
        bom: [bomRow('FG', 'IAW', 0.5)],
        intermediates: new Map([
          ['IAW', intermediate('IAW', { soak: true, dehydHours: 18 })],
        ]),
        intermediateCodes: new Set(['IAW']),
        lundbergSohByCode: {},
        scheduledSupply: [],
      });
      expect(runs[0]).toMatchObject({
        durationDays: 2,
        finishDate: '2026-05-14',
        startDate: '2026-05-13',
        availableDate: '2026-05-15',
      });
    });

    test('long dehydrate (e.g. 43h) → 2 days for dehydrate alone, plus soak = 3 days', () => {
      const runs = planKitchenRuns({
        packagingActivities: [
          { productCode: 'FG', productName: 'X', quantity: 100, date: '2026-05-15' },
        ],
        bom: [bomRow('FG', 'I', 1)],
        intermediates: new Map([
          ['I', intermediate('I', { soak: true, dehydHours: 43 })],
        ]),
        intermediateCodes: new Set(['I']),
        lundbergSohByCode: {},
        scheduledSupply: [],
      });
      expect(runs[0].durationDays).toBe(3); // 1 + ceil(43/24)=2 = 3
      expect(runs[0].finishDate).toBe('2026-05-14');
      expect(runs[0].startDate).toBe('2026-05-12');
    });
  });

  describe('cascading (multi-level)', () => {
    test('FCHOC → ICC → ICCC chain produces three-level run dates', () => {
      // Packaging 2026-05-15 → ICC (1d) needed by 15 → ICC start 14, finish 14.
      // ICC needs ICCC by ICC.startDate=14 → ICCC (1d) finish 13, start 13.
      const runs = planKitchenRuns({
        packagingActivities: [
          { productCode: 'FCHOC', productName: 'Choc', quantity: 100, date: '2026-05-15' },
        ],
        bom: [
          bomRow('FCHOC', 'ICC', 0.5),
          bomRow('ICC', 'ICCC', 0.4),
        ],
        intermediates: new Map([
          ['ICC', intermediate('ICC')],
          ['ICCC', intermediate('ICCC')],
        ]),
        intermediateCodes: new Set(['ICC', 'ICCC']),
        lundbergSohByCode: {},
        scheduledSupply: [],
      });
      expect(runs).toHaveLength(2);
      const icc = runs.find((r) => r.intermediateCode === 'ICC')!;
      const iccc = runs.find((r) => r.intermediateCode === 'ICCC')!;
      expect(icc.level).toBe(0);
      expect(iccc.level).toBe(1);
      expect(icc.startDate).toBe('2026-05-14');
      expect(iccc.finishDate).toBe('2026-05-13');
      // ICCC must finish before ICC starts:
      expect(iccc.finishDate < icc.startDate).toBe(true);
    });

    test('cascading respects each intermediate\'s own duration', () => {
      // ICC takes 2 days, ICCC takes 3 days. Packaging on 5/20.
      // ICC: finish 19, start 18 (durationDays=2, startDate = finishDate - (productionDays-1) = 19 - 1 = 18). ✓
      // ICCC: required by ICC.startDate = 18, finish 17, durationDays=3, start = 17 - 2 = 15.
      const runs = planKitchenRuns({
        packagingActivities: [
          { productCode: 'FG', productName: 'X', quantity: 50, date: '2026-05-20' },
        ],
        bom: [
          bomRow('FG', 'ICC', 1),
          bomRow('ICC', 'ICCC', 1),
        ],
        intermediates: new Map([
          ['ICC', intermediate('ICC', { soak: true, dehydHours: 18 })], // 2 days
          ['ICCC', intermediate('ICCC', { soak: true, dehydHours: 43 })], // 3 days
        ]),
        intermediateCodes: new Set(['ICC', 'ICCC']),
        lundbergSohByCode: {},
        scheduledSupply: [],
      });
      const icc = runs.find((r) => r.intermediateCode === 'ICC')!;
      const iccc = runs.find((r) => r.intermediateCode === 'ICCC')!;
      expect(icc.durationDays).toBe(2);
      expect(icc.finishDate).toBe('2026-05-19');
      expect(icc.startDate).toBe('2026-05-18');
      expect(iccc.durationDays).toBe(3);
      expect(iccc.finishDate).toBe('2026-05-17');
      expect(iccc.startDate).toBe('2026-05-15');
    });

    test('cascade halts when dependency chain is fully covered by SOH', () => {
      // ICC has 100 in stock. Packaging needs 50 of ICC. No new ICC run needed.
      // Therefore no derived ICCC demand.
      const runs = planKitchenRuns({
        packagingActivities: [
          { productCode: 'FG', productName: 'X', quantity: 100, date: '2026-05-15' },
        ],
        bom: [
          bomRow('FG', 'ICC', 0.5),
          bomRow('ICC', 'ICCC', 1),
        ],
        intermediates: new Map([
          ['ICC', intermediate('ICC')],
          ['ICCC', intermediate('ICCC')],
        ]),
        intermediateCodes: new Set(['ICC', 'ICCC']),
        lundbergSohByCode: { ICC: 100 },
        scheduledSupply: [],
      });
      expect(runs).toEqual([]);
    });

    test('cascade depth limited by maxLevels', () => {
      // 7 layers deep but maxLevels=2 → at most 2 runs from the chain (level 0 + level 1).
      const bom: BOMComponent[] = [];
      const intermMap = new Map<string, KitchenIntermediate>();
      const codes = ['I0', 'I1', 'I2', 'I3', 'I4', 'I5', 'I6'];
      for (let i = 0; i < codes.length - 1; i++) {
        bom.push(bomRow(codes[i], codes[i + 1], 1));
      }
      bom.unshift(bomRow('FG', 'I0', 1));
      for (const c of codes) intermMap.set(c, intermediate(c));

      const runs = planKitchenRuns({
        packagingActivities: [
          { productCode: 'FG', productName: 'X', quantity: 10, date: '2026-05-30' },
        ],
        bom,
        intermediates: intermMap,
        intermediateCodes: new Set(codes),
        lundbergSohByCode: {},
        scheduledSupply: [],
        maxLevels: 2,
      });
      // Levels 0 and 1 = 2 runs total (I0 and I1).
      expect(runs.length).toBe(2);
      expect(new Set(runs.map((r) => r.intermediateCode))).toEqual(new Set(['I0', 'I1']));
    });
  });

  describe('SOH + scheduled supply interaction', () => {
    test('partial SOH reduces gap; cascade still triggered for the gap portion', () => {
      // Need 100 of ICC. Have 30 in SOH. Gap 70. Cascade derives ICCC for the 70.
      const runs = planKitchenRuns({
        packagingActivities: [
          { productCode: 'FG', productName: 'X', quantity: 100, date: '2026-05-15' },
        ],
        bom: [
          bomRow('FG', 'ICC', 1),
          bomRow('ICC', 'ICCC', 1),
        ],
        intermediates: new Map([
          ['ICC', intermediate('ICC')],
          ['ICCC', intermediate('ICCC')],
        ]),
        intermediateCodes: new Set(['ICC', 'ICCC']),
        lundbergSohByCode: { ICC: 30 },
        scheduledSupply: [],
      });
      const icc = runs.find((r) => r.intermediateCode === 'ICC')!;
      const iccc = runs.find((r) => r.intermediateCode === 'ICCC')!;
      expect(icc.quantity).toBe(70);
      expect(iccc.quantity).toBe(70); // 70 of ICC × 1 ICCC per ICC
    });

    test('scheduled assembly delivery before required date covers the demand', () => {
      const runs = planKitchenRuns({
        packagingActivities: [
          { productCode: 'FG', productName: 'X', quantity: 100, date: '2026-05-20' },
        ],
        bom: [bomRow('FG', 'ICC', 1)],
        intermediates: new Map([['ICC', intermediate('ICC')]]),
        intermediateCodes: new Set(['ICC']),
        lundbergSohByCode: {},
        scheduledSupply: [
          { intermediateCode: 'ICC', date: '2026-05-18', quantity: 200, source: 'A-1' },
        ],
      });
      expect(runs).toEqual([]);
    });
  });

  describe('output ordering', () => {
    test('runs sorted by (startDate asc, code asc)', () => {
      const runs = planKitchenRuns({
        packagingActivities: [
          { productCode: 'FG1', productName: 'A', quantity: 10, date: '2026-05-30' },
          { productCode: 'FG2', productName: 'B', quantity: 10, date: '2026-05-15' },
        ],
        bom: [bomRow('FG1', 'I_A', 1), bomRow('FG2', 'I_B', 1)],
        intermediates: new Map([
          ['I_A', intermediate('I_A')],
          ['I_B', intermediate('I_B')],
        ]),
        intermediateCodes: new Set(['I_A', 'I_B']),
        lundbergSohByCode: {},
        scheduledSupply: [],
      });
      expect(runs.map((r) => `${r.startDate}/${r.intermediateCode}`)).toEqual([
        '2026-05-14/I_B',
        '2026-05-29/I_A',
      ]);
    });
  });
});
