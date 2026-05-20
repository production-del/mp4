/**
 * Kitchen-gap engine — Phase 4k.
 *
 * Forward-simulates per-intermediate inventory at Lundberg through time:
 *   start: SOH at Lundberg (today)
 *   add: scheduled-assembly deliveries on/before each date
 *   subtract: packaging-driven demand events
 *
 * When the running balance dips below zero, a `KitchenGap` is emitted —
 * a required new kitchen run for that intermediate, of the missing
 * quantity, by the demand date. The simulation continues with balance
 * reset to zero (i.e. the gap is assumed to be filled by the run we just
 * emitted), so multiple gaps appear when demand outpaces supply more
 * than once.
 *
 * Pure: no I/O. Deterministic given sorted inputs.
 *
 * Caveat: dates are treated as instantaneous events with no kitchen
 * production lead time. A gap on day 14 means "must have produced this
 * by day 14" — it doesn't account for the soak/dehydrate/mix lead time
 * that intermediate production actually takes. Phase 4k.3 (kitchen
 * capacity scheduling) will model that. For now, the operator should
 * read each gap as "kitchen needs this quantity ready by `requiredByDate`
 * — start production some working days earlier."
 */

import type { IntermediateDemandEvent } from './intermediate-demand';

// ─── Public types ────────────────────────────────────────────

export interface KitchenSupplyEvent {
  intermediateCode: string;
  /** YYYY-MM-DD when the supply lands at Lundberg. */
  date: string;
  quantity: number;
  /** Provenance — usually an Unleashed assembly number. */
  source: string;
}

export interface KitchenGap {
  intermediateCode: string;
  intermediateName: string;
  /** Units short. Always > 0. */
  shortfallQuantity: number;
  /** YYYY-MM-DD by which the new kitchen run must be ready. */
  requiredByDate: string;
  /** Provenance: which packaging batches the demand came from (around this gap). */
  drivers: Array<{
    productCode: string;
    productName: string;
    quantity: number;
  }>;
  /**
   * Phase 4l.12 — existing Unleashed assemblies for this intermediate
   * that land AFTER this gap's `requiredByDate`. When non-empty, the
   * planner is emitting a new kitchen run while Unleashed has already
   * scheduled production that's just too late to satisfy this shortage.
   * If the user can pull the Unleashed date forward, the new run
   * becomes redundant — flag it in the drawer / audit log.
   */
  redundantWithUnleashed?: ReadonlyArray<{
    assembly: string; // assembly number, e.g. AS-00016115
    date: string;     // scheduled date
    quantity: number;
  }>;
}

export interface KitchenGapInput {
  /** All intermediate-demand events from the packaging plan. */
  demand: ReadonlyArray<IntermediateDemandEvent>;
  /** Existing scheduled supply (Unleashed assemblies at Lundberg). */
  scheduledSupply: ReadonlyArray<KitchenSupplyEvent>;
  /** Current Lundberg SOH per intermediate code. */
  lundbergSohByCode: Record<string, number>;
  /**
   * Phase 4l.12 — emit a separate gap for every ~`consumptionWindowDays`
   * of forward demand instead of coalescing the whole horizon into one
   * massive gap. Spreads kitchen runs across the horizon so Lundberg
   * peak storage stays roughly = one window's demand rather than the
   * whole horizon's demand. Default 5; set 0 to disable (= revert to
   * single-gap behaviour).
   */
  consumptionWindowDays?: number;
  /**
   * Phase 4l.12 — per-intermediate `preferredBatchSize` (kg INPUT per
   * run). When set, the gap walk credits `ceil(deficit/batch) × batch`
   * to the running balance after emitting a gap, so excess production
   * from the recipe-mandated batch size reduces future gaps. Without
   * this, the engine over-emits: a 200kg deficit triggers a 300kg run
   * (recipe constraint) but the engine still emits the next window's
   * full demand as a fresh gap, double-producing.
   *
   * The DOWNSTREAM yield rate is also accounted for: input × yield =
   * output, so if yield < 1 the credited output is `batch × yield`.
   */
  preferredBatchByIntermediate?: Record<string, { batch: number; yield: number }>;
}

// ─── Public API ──────────────────────────────────────────────

// Phase 4l.12 — default window is 1 day so each shortage event emits its
// own gap dated to that day. With the surplus-credit logic below, this
// effectively produces a just-in-time stream of kitchen runs each tied
// to a specific consumer event, rather than bundling a week's worth of
// demand into one early-dated cluster. Set higher (e.g. 5) to coalesce
// events within a window when desired.
const DEFAULT_CONSUMPTION_WINDOW_DAYS = 1;

/** Shift an ISO `YYYY-MM-DD` by `delta` days (no timezone math). */
function shiftIsoDate(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function computeKitchenGaps(input: KitchenGapInput): KitchenGap[] {
  const windowDays = input.consumptionWindowDays ?? DEFAULT_CONSUMPTION_WINDOW_DAYS;
  // Group events by intermediate code so each can be simulated independently.
  // Phase 4l.12: supply events also carry `source` (assembly number) so
  // we can flag redundant-with-Unleashed gaps later.
  const byCode = new Map<
    string,
    {
      name: string;
      events: Array<
        | { kind: 'demand'; date: string; quantity: number; driver: IntermediateDemandEvent['drivenBy'] }
        | { kind: 'supply'; date: string; quantity: number; source: string }
      >;
    }
  >();

  for (const d of input.demand) {
    let bucket = byCode.get(d.intermediateCode);
    if (!bucket) {
      bucket = { name: d.intermediateName, events: [] };
      byCode.set(d.intermediateCode, bucket);
    }
    bucket.events.push({
      kind: 'demand',
      date: d.requiredByDate,
      quantity: d.quantity,
      driver: d.drivenBy,
    });
  }
  for (const s of input.scheduledSupply) {
    let bucket = byCode.get(s.intermediateCode);
    if (!bucket) {
      // Supply for a code that has no demand — irrelevant; skip. We only
      // care about gaps, not surpluses.
      continue;
    }
    bucket.events.push({ kind: 'supply', date: s.date, quantity: s.quantity, source: s.source });
  }

  const gaps: KitchenGap[] = [];

  for (const [code, bucket] of byCode.entries()) {
    // Simulate this intermediate's running balance.
    // Sort events by date; supply on the SAME date is applied BEFORE demand
    // (a delivery scheduled for today is available for today's consumption).
    const events = bucket.events.slice().sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      if (a.kind !== b.kind) return a.kind === 'supply' ? -1 : 1;
      return 0;
    });

    // Phase 4l.12 — emit ONE gap per ~consumptionWindowDays of forward
    // demand, instead of one giant gap covering the whole horizon. This
    // distributes kitchen runs across the horizon so Lundberg peak
    // storage stays close to a window's demand rather than ballooning
    // to the full horizon. Each gap is dated to the first shortage
    // point inside its window; downstream `planKitchenRuns` then backs
    // off the lead time and applies preferredBatchSize rounding.
    //
    // When `windowDays <= 0` we fall through to the legacy single-gap
    // behaviour (sum total demand − total supply − SOH, emit once).
    const initialSoh = input.lundbergSohByCode[code] ?? 0;

    if (windowDays <= 0) {
      // Legacy: coalesce horizon into one gap. Kept for tests/back-compat.
      let balance = initialSoh;
      let totalDemand = 0;
      let totalSupply = 0;
      let firstShortageDate: string | null = null;
      let firstShortageDrivers: IntermediateDemandEvent['drivenBy'][] | null = null;
      const pendingDrivers: IntermediateDemandEvent['drivenBy'][] = [];
      for (const e of events) {
        if (e.kind === 'supply') {
          balance += e.quantity;
          totalSupply += e.quantity;
        } else {
          balance -= e.quantity;
          totalDemand += e.quantity;
          pendingDrivers.push(e.driver);
          if (firstShortageDate === null && balance < 0) {
            firstShortageDate = e.date;
            firstShortageDrivers = [...pendingDrivers];
          }
        }
      }
      const cumulativeShortfall = totalDemand - initialSoh - totalSupply;
      if (firstShortageDate !== null && cumulativeShortfall > 0) {
        gaps.push({
          intermediateCode: code,
          intermediateName: bucket.name,
          shortfallQuantity: cumulativeShortfall,
          requiredByDate: firstShortageDate,
          drivers: (firstShortageDrivers ?? []).map((d) => ({
            productCode: d.productCode,
            productName: d.productName,
            quantity: d.packagingQuantity,
          })),
        });
      }
      continue;
    }

    // ─── Phase 4l.12 multi-gap walk ─────────────────────────
    // We separate supply events from demand events. Supplies (initial
    // SOH + scheduled assemblies) build up a running balance that the
    // demand sequence consumes. When the next demand event would push
    // balance below zero, we open a new gap window from THAT date and
    // accumulate every demand event whose date falls within the window.
    // The gap quantity = sum of demand in the window; we treat the
    // virtual kitchen run as adding `gapQty` to the running balance
    // (= what the new run will produce, available before the window
    // starts being consumed).
    let balance = initialSoh;
    // Pre-apply supply events whose dates fall before any demand;
    // they're fungible boosts to the starting balance.
    // We'll consume supply on-date during the walk too.
    const demandList = events
      .filter((e): e is typeof e & { kind: 'demand' } => e.kind === 'demand')
      .map((e) => ({ ...e }));
    const supplyList = events
      .filter((e): e is typeof e & { kind: 'supply' } => e.kind === 'supply')
      .map((e) => ({ ...e }));
    let supplyIdx = 0;

    for (let i = 0; i < demandList.length; ) {
      const d = demandList[i];
      // Apply any supply events that land on or before this demand date.
      while (supplyIdx < supplyList.length && supplyList[supplyIdx].date <= d.date) {
        balance += supplyList[supplyIdx].quantity;
        supplyIdx += 1;
      }
      if (balance >= d.quantity) {
        balance -= d.quantity;
        i += 1;
        continue;
      }
      // Shortage at demandList[i]. Open a window of `windowDays` from
      // this date and accumulate the demand inside. Phase 4l.12 strict
      // semantics: windowDays=1 means the trigger day ONLY (events with
      // date < d.date + 1 = same day). windowDays=N means N
      // consecutive days starting at d.date. The strict `<` against
      // windowEnd avoids the prior "1-day window actually bundles 2
      // days" footgun.
      const windowEnd = shiftIsoDate(d.date, windowDays);
      let gapQty = 0;
      const gapDrivers: IntermediateDemandEvent['drivenBy'][] = [];
      let j = i;
      // We already have `balance` worth of stock. Consume it against
      // demand inside the window FIRST so the gap only covers the
      // true deficit. (Same end result as setting balance to 0 after
      // emit, but cleaner for accounting.)
      while (j < demandList.length && demandList[j].date < windowEnd) {
        const dj = demandList[j];
        // Apply supply between demand events too.
        while (
          supplyIdx < supplyList.length &&
          supplyList[supplyIdx].date <= dj.date
        ) {
          balance += supplyList[supplyIdx].quantity;
          supplyIdx += 1;
        }
        if (balance >= dj.quantity) {
          balance -= dj.quantity;
        } else {
          // Deficit on this event.
          const deficit = dj.quantity - balance;
          balance = 0;
          gapQty += deficit;
          gapDrivers.push(dj.driver);
        }
        j += 1;
      }
      if (gapQty > 0) {
        // Phase 4l.12: identify Unleashed assemblies for this same
        // intermediate that land AFTER the gap's date — they could
        // have satisfied this shortage if rescheduled earlier. Flag so
        // the user can choose to reschedule in Unleashed instead of
        // double-producing. We look at the ORIGINAL supplyList (not
        // supplyIdx-filtered) so this works even when supplyIdx has
        // already advanced past late assemblies.
        const redundantWithUnleashed = supplyList
          .filter((s) => s.date > d.date && s.quantity > 0 && s.source.startsWith('AS-'))
          .map((s) => ({ assembly: s.source, date: s.date, quantity: s.quantity }));
        gaps.push({
          intermediateCode: code,
          intermediateName: bucket.name,
          shortfallQuantity: gapQty,
          requiredByDate: d.date,
          drivers: gapDrivers.map((dr) => ({
            productCode: dr.productCode,
            productName: dr.productName,
            quantity: dr.packagingQuantity,
          })),
          redundantWithUnleashed:
            redundantWithUnleashed.length > 0 ? redundantWithUnleashed : undefined,
        });
        // Phase 4l.12: credit the FULL post-rounding output back to the
        // running balance so subsequent windows account for the surplus
        // and don't emit redundant gaps. Without this, the gap walk
        // requests a 200kg output deficit → planKitchenRuns rounds to
        // 300kg input batch → output 300×yield − 200 surplus is
        // invisible to the next window, which emits another full
        // deficit gap.
        //
        // gapQty is in OUTPUT units (= what the consumer needs). The
        // matching kitchen run produces `ceil(gapQty/yield/batch) ×
        // batch` of INPUT, which becomes `× yield` of OUTPUT. Yield
        // uplift must happen BEFORE the batch-ceil — applying batch
        // directly to output qty under-rounds for yield < 1 recipes.
        const recipe = input.preferredBatchByIntermediate?.[code];
        if (recipe && recipe.batch > 0) {
          const y = recipe.yield > 0 ? recipe.yield : 1;
          const rawInput = gapQty / y; // output → input via yield uplift
          const inputQty = Math.ceil(rawInput / recipe.batch) * recipe.batch;
          const outputQty = inputQty * y;
          balance += Math.max(0, outputQty - gapQty);
        }
      }
      i = j;
    }
  }

  // Stable order for downstream rendering.
  gaps.sort((a, b) => {
    if (a.requiredByDate !== b.requiredByDate) {
      return a.requiredByDate.localeCompare(b.requiredByDate);
    }
    return a.intermediateCode.localeCompare(b.intermediateCode);
  });

  return gaps;
}
