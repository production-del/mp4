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
  productionHints: {
    soak?: boolean;
    cook?: boolean;
    dehydHours?: number;
    yieldRate?: number | null;
    preferredBatchSize?: number | null;
  } = {},
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
    yieldRate:
      productionHints.yieldRate !== undefined ? productionHints.yieldRate : null,
    preferredBatchSize:
      productionHints.preferredBatchSize !== undefined
        ? productionHints.preferredBatchSize
        : null,
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

  // ─── Today-floor (Phase 4l.4) ──────────────────────────────

  describe('today-floor on overdue starts', () => {
    test('ideal start before today is clamped forward; overdue flag set', () => {
      // Packaging 2026-05-15, ICC takes 1 day → ideal start = 2026-05-14.
      // Today = 2026-05-20 → ideal start < today → clamped to 2026-05-20.
      // finishDate = startDate + (1-1) = 2026-05-20.
      const runs = planKitchenRuns({
        packagingActivities: [
          { productCode: 'FCHOC', productName: 'Choc', quantity: 100, date: '2026-05-15' },
        ],
        bom: [bomRow('FCHOC', 'ICC', 0.5)],
        intermediates: new Map([['ICC', intermediate('ICC')]]),
        intermediateCodes: new Set(['ICC']),
        lundbergSohByCode: {},
        scheduledSupply: [],
        today: '2026-05-20',
      });
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        intermediateCode: 'ICC',
        startDate: '2026-05-20',
        finishDate: '2026-05-20',
        availableDate: '2026-05-21',
        overdue: true,
        idealStartDate: '2026-05-14',
      });
    });

    test('ideal start AFTER today is unchanged; overdue is false', () => {
      // Packaging Mon 2026-06-15. 1-day mix recipe. ideal finish = Sun 06-14;
      // ideal start would be Sun → workday-pulled back to Fri 06-12.
      const runs = planKitchenRuns({
        packagingActivities: [
          { productCode: 'FCHOC', productName: 'Choc', quantity: 100, date: '2026-06-15' },
        ],
        bom: [bomRow('FCHOC', 'ICC', 0.5)],
        intermediates: new Map([['ICC', intermediate('ICC')]]),
        intermediateCodes: new Set(['ICC']),
        lundbergSohByCode: {},
        scheduledSupply: [],
        today: '2026-05-20',
      });
      expect(runs[0]).toMatchObject({
        startDate: '2026-06-12',
        overdue: false,
        idealStartDate: '2026-06-12',
      });
    });

    test('today omitted: legacy behaviour, no clamping even for past starts', () => {
      const runs = planKitchenRuns({
        packagingActivities: [
          { productCode: 'FCHOC', productName: 'Choc', quantity: 100, date: '2026-05-15' },
        ],
        bom: [bomRow('FCHOC', 'ICC', 0.5)],
        intermediates: new Map([['ICC', intermediate('ICC')]]),
        intermediateCodes: new Set(['ICC']),
        lundbergSohByCode: {},
        scheduledSupply: [],
        // no `today`
      });
      expect(runs[0]).toMatchObject({
        startDate: '2026-05-14',
        overdue: false,
        idealStartDate: '2026-05-14',
      });
    });

    test('1-day mix on weekend pulls back to Friday — start and finish both Fri', () => {
      // Packaging Mon 2026-05-25. Buffer 1 → ideal finish Sun. 1-day mix
      // would start Sun → workday-clamped back to Fri 2026-05-22. Finish
      // re-derived from clamped start = Fri (mix-only fits in one day).
      const runs = planKitchenRuns({
        packagingActivities: [
          { productCode: 'FCHOC', productName: 'Choc', quantity: 100, date: '2026-05-25' },
        ],
        bom: [bomRow('FCHOC', 'ICC', 0.5)],
        intermediates: new Map([['ICC', intermediate('ICC')]]),
        intermediateCodes: new Set(['ICC']),
        lundbergSohByCode: {},
        scheduledSupply: [],
      });
      expect(runs[0]).toMatchObject({
        durationDays: 1,
        startDate: '2026-05-22',
        finishDate: '2026-05-22',
        availableDate: '2026-05-23',
        overdue: false,
        idealStartDate: '2026-05-22',
      });
    });

    test('3-day soak+dehyd (IAW case) keeps passive steps over weekend', () => {
      // Packaging Mon 2026-05-25. Buffer 1 → ideal finish Sun 24. 3-day
      // recipe (soak + 2-day dehyd). Ideal start = Fri 22 (already workday).
      // Start Fri 22 (mix/soak), Sat 23 dehydrate (passive), Sun 24 dehydrate
      // (passive), available Mon 25 — exactly what we want for IAW.
      const runs = planKitchenRuns({
        packagingActivities: [
          { productCode: 'FG', productName: 'X', quantity: 100, date: '2026-05-25' },
        ],
        bom: [bomRow('FG', 'IAW', 0.5)],
        intermediates: new Map([
          ['IAW', intermediate('IAW', { soak: true, dehydHours: 43 })],
        ]),
        intermediateCodes: new Set(['IAW']),
        lundbergSohByCode: {},
        scheduledSupply: [],
      });
      expect(runs[0]).toMatchObject({
        durationDays: 3,
        startDate: '2026-05-22',
        finishDate: '2026-05-24',
        availableDate: '2026-05-25',
        overdue: false,
      });
    });

    test('today on weekend clamps forward to next Monday', () => {
      // Packaging Mon 2026-05-25, today = Sat 2026-05-23. 1-day mix. Ideal
      // start = Fri 22 (workday), but Fri < Sat 23 → clamp forward.
      // Next workday after Sat = Mon 25. Start Mon (overdue).
      const runs = planKitchenRuns({
        packagingActivities: [
          { productCode: 'FCHOC', productName: 'Choc', quantity: 100, date: '2026-05-25' },
        ],
        bom: [bomRow('FCHOC', 'ICC', 0.5)],
        intermediates: new Map([['ICC', intermediate('ICC')]]),
        intermediateCodes: new Set(['ICC']),
        lundbergSohByCode: {},
        scheduledSupply: [],
        today: '2026-05-23',
      });
      expect(runs[0]).toMatchObject({
        startDate: '2026-05-25',
        overdue: true,
      });
    });

    test('multi-day production: clamped start pushes finish forward by durationDays-1', () => {
      // 2-day production (soak + dehydrate <=24h). Today=2026-05-20.
      // finish = startDate + 1.
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
        today: '2026-05-20',
      });
      expect(runs[0]).toMatchObject({
        durationDays: 2,
        startDate: '2026-05-20',
        finishDate: '2026-05-21',
        availableDate: '2026-05-22',
        overdue: true,
      });
    });
  });

  describe('Phase 4l.10 — yield-uplift + recipe-batch rounding', () => {
    test('IABKBR-style: 600 FG at 0.342 ratio → yield 0.948 + batch 250 → run = 250kg', () => {
      // 600 × 0.342 = 205.2 kg OUTPUT demand. SOH=0.
      // rawInput = ceil(205.2 / 0.948) = 217
      // batches  = ceil(217 / 250) = 1
      // inputKg  = 250  ← matches kitchen recipe
      const runs = planKitchenRuns({
        packagingActivities: [
          { productCode: 'MFBKBRYBG', productName: 'Berry Buckies', quantity: 600, date: '2026-06-01' },
        ],
        bom: [bomRow('MFBKBRYBG', 'IABKBR', 0.342)],
        intermediates: new Map([
          ['IABKBR', intermediate('IABKBR', { yieldRate: 0.948, preferredBatchSize: 250 })],
        ]),
        intermediateCodes: new Set(['IABKBR']),
        lundbergSohByCode: {},
        scheduledSupply: [],
      });
      expect(runs).toHaveLength(1);
      expect(runs[0].quantity).toBe(250);
    });

    test('demand exactly matches yield-adjusted batch → still 1 batch (no extra)', () => {
      // 500 × 0.5 = 250 OUTPUT. yield 1.0, batch 250 → rawInput=250, batches=1.
      const runs = planKitchenRuns({
        packagingActivities: [
          { productCode: 'FG', productName: 'X', quantity: 500, date: '2026-06-01' },
        ],
        bom: [bomRow('FG', 'INT', 0.5)],
        intermediates: new Map([
          ['INT', intermediate('INT', { yieldRate: 1.0, preferredBatchSize: 250 })],
        ]),
        intermediateCodes: new Set(['INT']),
        lundbergSohByCode: {},
        scheduledSupply: [],
      });
      expect(runs[0].quantity).toBe(250);
    });

    test('demand slightly over one batch → rounds up to 2 batches', () => {
      // 1000 × 0.3 = 300 OUTPUT. yield 1.0, batch 250.
      // rawInput=300, batches=ceil(300/250)=2 → 500kg.
      const runs = planKitchenRuns({
        packagingActivities: [
          { productCode: 'FG', productName: 'X', quantity: 1000, date: '2026-06-01' },
        ],
        bom: [bomRow('FG', 'INT', 0.3)],
        intermediates: new Map([
          ['INT', intermediate('INT', { yieldRate: 1.0, preferredBatchSize: 250 })],
        ]),
        intermediateCodes: new Set(['INT']),
        lundbergSohByCode: {},
        scheduledSupply: [],
      });
      expect(runs[0].quantity).toBe(500);
    });

    test('no preferredBatchSize → yield-uplift only, no rounding', () => {
      // 1000 × 0.3 = 300 OUTPUT. yield 0.85, no batch column.
      // rawInput = ceil(300 / 0.85) = 353. No rounding → 353.
      const runs = planKitchenRuns({
        packagingActivities: [
          { productCode: 'FG', productName: 'X', quantity: 1000, date: '2026-06-01' },
        ],
        bom: [bomRow('FG', 'INT', 0.3)],
        intermediates: new Map([
          ['INT', intermediate('INT', { yieldRate: 0.85, preferredBatchSize: null })],
        ]),
        intermediateCodes: new Set(['INT']),
        lundbergSohByCode: {},
        scheduledSupply: [],
      });
      expect(runs[0].quantity).toBe(353);
    });

    test('SOH covers most demand → small shortfall still rounds up to full batch', () => {
      // 600 × 0.342 = 205.2 OUTPUT demand. SOH = 200 → shortfall 5.2.
      // rawInput = ceil(5.2 / 0.948) = 6. Round to batch 250 → 250kg.
      // (= the team always runs a full batch, no half-IBCs.)
      const runs = planKitchenRuns({
        packagingActivities: [
          { productCode: 'MFBKBRYBG', productName: 'Berry Buckies', quantity: 600, date: '2026-06-01' },
        ],
        bom: [bomRow('MFBKBRYBG', 'IABKBR', 0.342)],
        intermediates: new Map([
          ['IABKBR', intermediate('IABKBR', { yieldRate: 0.948, preferredBatchSize: 250 })],
        ]),
        intermediateCodes: new Set(['IABKBR']),
        lundbergSohByCode: { IABKBR: 200 },
        scheduledSupply: [],
      });
      expect(runs[0].quantity).toBe(250);
    });

    test('SOH fully covers demand → no kitchen run', () => {
      const runs = planKitchenRuns({
        packagingActivities: [
          { productCode: 'MFBKBRYBG', productName: 'Berry Buckies', quantity: 600, date: '2026-06-01' },
        ],
        bom: [bomRow('MFBKBRYBG', 'IABKBR', 0.342)],
        intermediates: new Map([
          ['IABKBR', intermediate('IABKBR', { yieldRate: 0.948, preferredBatchSize: 250 })],
        ]),
        intermediateCodes: new Set(['IABKBR']),
        lundbergSohByCode: { IABKBR: 500 },
        scheduledSupply: [],
      });
      expect(runs).toHaveLength(0);
    });
  });
});
