import { projectPoChips } from '@/lib/planning/po-projection';
import type { PurchaseRequirement } from '@/lib/engine/raw-material-demand';

function req(o: Partial<PurchaseRequirement> & {
  rawMaterialCode: string;
  placeByDate: string;
  arriveByDate: string;
  leadTimeDays: number;
  quantity: number;
}): PurchaseRequirement {
  return {
    rawMaterialCode: o.rawMaterialCode,
    rawMaterialName: o.rawMaterialName ?? o.rawMaterialCode,
    placeByDate: o.placeByDate,
    arriveByDate: o.arriveByDate,
    leadTimeDays: o.leadTimeDays,
    quantity: o.quantity,
    overdue: o.overdue ?? false,
    drivenBy: o.drivenBy ?? [],
  };
}

describe('projectPoChips', () => {
  test('emits one place + one receive chip per requirement', () => {
    const chips = projectPoChips({
      purchaseRequirements: [
        req({
          rawMaterialCode: 'RAW_X',
          placeByDate: '2026-05-01',
          arriveByDate: '2026-05-15',
          leadTimeDays: 14,
          quantity: 100,
        }),
      ],
      today: '2026-04-01',
    });
    expect(chips).toHaveLength(2);
    const place = chips.find((c) => c.kind === 'po-placed')!;
    const receive = chips.find((c) => c.kind === 'po-receiving')!;
    expect(place.date).toBe('2026-05-01');
    expect(receive.date).toBe('2026-05-15');
    expect(place.poInfo?.sisterStableId).toBe(receive.stableId);
    expect(receive.poInfo?.sisterStableId).toBe(place.stableId);
  });

  test('clamps overdue place-by to today; receive-by slides forward by the same delta', () => {
    const chips = projectPoChips({
      purchaseRequirements: [
        req({
          rawMaterialCode: 'RAW_X',
          placeByDate: '2026-04-25', // 10 days before today
          arriveByDate: '2026-05-09',
          leadTimeDays: 14,
          quantity: 100,
        }),
      ],
      today: '2026-05-05',
    });
    const place = chips.find((c) => c.kind === 'po-placed')!;
    const receive = chips.find((c) => c.kind === 'po-receiving')!;
    expect(place.date).toBe('2026-05-05'); // clamped to today
    expect(receive.date).toBe('2026-05-19'); // today + 14
    expect(place.poInfo?.overdue).toBe(true);
    // poInfo retains the IDEAL dates for the drawer to display.
    expect(place.poInfo?.placeByDate).toBe('2026-04-25');
    expect(place.poInfo?.arriveByDate).toBe('2026-05-09');
    expect(place.poInfo?.leadTimeDays).toBe(14);
  });

  test('lead-time override replaces the file default', () => {
    const chips = projectPoChips({
      purchaseRequirements: [
        req({
          rawMaterialCode: 'RAW_X',
          placeByDate: '2026-05-10',
          arriveByDate: '2026-05-24',
          leadTimeDays: 14,
          quantity: 100,
        }),
      ],
      today: '2026-05-01',
      leadTimeOverrideDaysByCode: { RAW_X: 21 },
    });
    const place = chips.find((c) => c.kind === 'po-placed')!;
    const receive = chips.find((c) => c.kind === 'po-receiving')!;
    // Place stays at the ideal placeBy because it's still after today.
    expect(place.date).toBe('2026-05-10');
    // Receive uses the OVERRIDE (21 days), not the ideal 14.
    expect(receive.date).toBe('2026-05-31');
    // poInfo.leadTimeDays still reflects the FILE default for drawer comparison.
    expect(place.poInfo?.leadTimeDays).toBe(14);
  });

  test('override + overdue: place clamped to today, receive = today + override', () => {
    const chips = projectPoChips({
      purchaseRequirements: [
        req({
          rawMaterialCode: 'RAW_X',
          placeByDate: '2026-04-20', // overdue
          arriveByDate: '2026-05-04',
          leadTimeDays: 14,
          quantity: 100,
        }),
      ],
      today: '2026-05-05',
      leadTimeOverrideDaysByCode: { RAW_X: 7 }, // expedited
    });
    const place = chips.find((c) => c.kind === 'po-placed')!;
    const receive = chips.find((c) => c.kind === 'po-receiving')!;
    expect(place.date).toBe('2026-05-05');
    expect(receive.date).toBe('2026-05-12'); // today + 7
    expect(place.poInfo?.overdue).toBe(true);
  });

  test('non-finite or negative override is ignored (falls back to file default)', () => {
    const chips = projectPoChips({
      purchaseRequirements: [
        req({
          rawMaterialCode: 'RAW_X',
          placeByDate: '2026-05-10',
          arriveByDate: '2026-05-24',
          leadTimeDays: 14,
          quantity: 100,
        }),
      ],
      today: '2026-05-01',
      leadTimeOverrideDaysByCode: { RAW_X: NaN as unknown as number },
    });
    const receive = chips.find((c) => c.kind === 'po-receiving')!;
    // Falls back to file default 14.
    expect(receive.date).toBe('2026-05-24');
  });

  test('negative override ignored', () => {
    const chips = projectPoChips({
      purchaseRequirements: [
        req({
          rawMaterialCode: 'RAW_X',
          placeByDate: '2026-05-10',
          arriveByDate: '2026-05-24',
          leadTimeDays: 14,
          quantity: 100,
        }),
      ],
      today: '2026-05-01',
      leadTimeOverrideDaysByCode: { RAW_X: -5 },
    });
    const receive = chips.find((c) => c.kind === 'po-receiving')!;
    expect(receive.date).toBe('2026-05-24');
  });

  test('multiple requirements emit independent chip pairs', () => {
    const chips = projectPoChips({
      purchaseRequirements: [
        req({ rawMaterialCode: 'A', placeByDate: '2026-05-10', arriveByDate: '2026-05-24', leadTimeDays: 14, quantity: 100 }),
        req({ rawMaterialCode: 'B', placeByDate: '2026-05-15', arriveByDate: '2026-05-22', leadTimeDays: 7, quantity: 50 }),
      ],
      today: '2026-05-01',
    });
    expect(chips).toHaveLength(4);
    expect(chips.map((c) => c.stableId).sort()).toEqual(
      ['po-placed|A', 'po-placed|B', 'po-receiving|A', 'po-receiving|B'].sort(),
    );
  });
});
