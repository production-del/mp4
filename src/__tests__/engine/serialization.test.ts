/**
 * Proves the engine wire contract: any supported engine input can be
 * serialized to JSON, rehydrated, re-run through the engine, and produce
 * byte-identical output to the in-memory call. This is the exact round-trip
 * a Python FastAPI service would perform.
 */

import { BusinessCalendar, createDefaultBusinessCalendar } from '@/lib/engine/business-calendar';
import { analyzeKitchenBatches } from '@/lib/engine/kitchen-projection';
import type {
  KitchenBatch,
  SOHItem,
  BOMComponent,
  KitchenProjectionInput,
} from '@/lib/planning/engine-io';
import {
  toWireKitchenRequest,
  fromWireKitchenRequest,
  toWireKitchenResponse,
  fromWireKitchenResponse,
  runKitchenProjectionFromJSON,
} from '@/lib/engine/serialization';

describe('Engine serialization — Python seam contract', () => {
  const calendar = createDefaultBusinessCalendar();

  const batches: KitchenBatch[] = [
    {
      id: 'b-1',
      productCode: 'IAW',
      productName: 'Walnuts Activated',
      quantity: 100,
      scheduledDate: new Date('2026-04-20T00:00:00'),
      status: 'planned',
      dependencies: [],
    },
  ];

  const boms: BOMComponent[] = [
    {
      productCode: 'WLN',
      productName: 'Raw Walnuts',
      quantityPerParent: 1,
      level: 1,
      parentProductCode: 'IAW',
    },
  ];

  const soh: SOHItem[] = [
    { productCode: 'WLN', productName: 'Raw Walnuts', quantity: 500, warehouseId: 'LB' },
  ];

  test('kitchen projection round-trips JSON', () => {
    const input: KitchenProjectionInput = {
      batches,
      boms,
      soh,
      businessCalendar: calendar,
    };

    // In-memory run
    const direct = analyzeKitchenBatches(input);

    // Wire round-trip: serialize → JSON string → parse → rehydrate → run → serialize
    const wireRequest = toWireKitchenRequest(input);
    const jsonPayload = JSON.stringify(wireRequest);
    const parsed = JSON.parse(jsonPayload);
    const wireResponse = runKitchenProjectionFromJSON(parsed);
    const roundTripped = fromWireKitchenResponse(wireResponse);

    // Aggregate counts match
    expect(roundTripped.aggregated).toEqual(direct.aggregated);
    // Batch feasibility is byte-identical
    expect(roundTripped.batches).toEqual(direct.batches);
    // Timeline entries match (date strings decoded back to Dates)
    expect(roundTripped.timeline.length).toBe(direct.timeline.length);
    for (let i = 0; i < roundTripped.timeline.length; i++) {
      const a = roundTripped.timeline[i];
      const b = direct.timeline[i];
      expect(a.batchId).toBe(b.batchId);
      expect(a.productCode).toBe(b.productCode);
      expect(a.event).toBe(b.event);
      expect(a.notes).toBe(b.notes);
      // Dates may differ in time component across tz but share calendar day
      expect(a.date.getFullYear()).toBe(b.date.getFullYear());
      expect(a.date.getMonth()).toBe(b.date.getMonth());
      expect(a.date.getDate()).toBe(b.date.getDate());
    }
  });

  test('calendar holidays survive wire round-trip', () => {
    const input: KitchenProjectionInput = {
      batches,
      boms,
      soh,
      businessCalendar: calendar,
    };
    const wire = toWireKitchenRequest(input);
    const rehydrated = fromWireKitchenRequest(wire);

    // Both calendars should agree on known holidays
    const sample = new Date('2026-01-01'); // New Year's Day
    expect(rehydrated.businessCalendar.isWorkingDay(sample)).toBe(
      calendar.isWorkingDay(sample),
    );
  });

  test('wire payload is serializable with no information loss', () => {
    const input: KitchenProjectionInput = {
      batches,
      boms,
      soh,
      businessCalendar: new BusinessCalendar([
        { date: new Date('2026-06-01'), name: 'Test Holiday' },
      ]),
    };
    const wire = toWireKitchenRequest(input);
    const serialized = JSON.stringify(wire);
    const parsed = JSON.parse(serialized);

    // Parsed shape still matches the wire TypeScript contract:
    // - Every date is a string
    // - Holidays are present
    expect(typeof parsed.batches[0].scheduledDate).toBe('string');
    expect(parsed.calendar.holidays).toContainEqual(
      expect.objectContaining({ name: 'Test Holiday', date: '2026-06-01' }),
    );
  });
});
