# Supplier + Ingredient Tracker — Integration Brief

A short brief for the engineer building a companion Supplier + Ingredient Tracker app that will eventually integrate with the Byron Planner (this repo). The goal: adopt the same design philosophy and shared primitives so integration is cheap when we reach for it.

---

## 1. The companion it integrates with

The Byron Planner is a Next.js 15 / TypeScript app that:

- Plans a 4-phase production pipeline: **FG Planning → Kitchen → Purchasing → Execution**.
- Reads **Unleashed** (the ERP) as the source of truth for Products, Warehouses, SOH, Assemblies, Purchase Orders.
- Adds planning-layer concepts Unleashed doesn't model: demand over time, feasibility, batch scheduling, warehouse assignment, supplier preferences.
- Pushes confirmed plans back to Unleashed as Assemblies and Purchase Orders.

**Where your app fits:** the planner currently has thin knowledge of suppliers and ingredients. Lead times, prices, MOQs, preferred suppliers, certifications, contract terms, alternative sources — none of that is modelled. When the planner drafts a PO, it knows *which component and how much*, but not *which supplier, at what price, with what lead time*. Your tracker fills that gap.

---

## 2. Design philosophy

Six principles that emerged from a recent ontology-first refactor. Adopting them early is 10× cheaper than refactoring to them later.

### 2.1 Unleashed is an adapter at the edge, not your core model

Unleashed types (`Product`, `Supplier`, `Warehouse`, …) live in `src/lib/unleashed/` and are adapted in at fetch time and adapted out at push time. Your **domain types own the middle**. Don't let PascalCase ERP shapes leak into your UI code; adapt them at the API boundary.

### 2.2 Canonical inputs, not derived ones

Demand rates come from a CSV, never from historical assembly data. The reason: derived demand creates circular plans ("we've been making X, therefore we plan to make X"). Your equivalent: if you track preferred suppliers, make it an explicit choice, not a ranking derived from past POs. Explicitness survives scale and audits.

### 2.3 One type per concept, discriminated unions for variants

Don't let the same idea exist in three shapes (e.g., `KitchenBatch` / `ScheduledBatch` / `BatchItem`). Pick one base type with a `kind` discriminator. In the planner, every plan item (kitchen run, packaging run, PO, transfer) is a variant of `PlanItem`. In your app, consider a `SupplyRecord` base with variants for price quote, contract, shipment, certification.

### 2.4 Dates at the boundaries, ISO strings in the middle

`Date` objects are fine in React state and form inputs. Anything that crosses a store boundary (localStorage, URL, API, JSON log) should be a local ISO string (`YYYY-MM-DD`). Reuse our `lib/planning/working-day.ts` helpers rather than reimplementing `toISOString()` (which silently shifts Australian dates to UTC).

### 2.5 Pure engines, thin hooks

Business logic — pricing, MOQ satisfaction, alternative-source fallback, lead-time math — lives in pure functions that take JSON-serializable input and return JSON-serializable output. React hooks are thin wrappers that wire these into component state. This is what lets us swap the engine for a Python service later with no UI changes.

### 2.6 One-shot migrations, clean breaks

When you change a storage shape, migrate on first read and delete the old key. Don't maintain forever-compat layers. You're the sole operator; regression cost is low, and migration code that's "still there just in case" becomes permanent debt.

---

## 3. Domain types — suggested starting shapes

Sketch only — refine as the domain clarifies. These aren't imports from the planner (yet); they're the shapes you'll probably want.

```typescript
// A product/ingredient you buy. productCode matches Unleashed's product code
// exactly — the join key between your app and ours.
interface Ingredient {
  productCode: string;           // e.g., "WLN-RAW" — matches Unleashed ProductCode
  productName: string;
  category: 'raw_material' | 'intermediate' | 'packaging' | 'label';
  unitOfMeasure: 'kg' | 'L' | 'unit' | 'roll' | string;
  certifications?: Certification[];
  allergens?: string[];
  notes?: string;
}

// A supplier. supplierId matches Unleashed's Supplier Guid.
interface Supplier {
  supplierId: string;            // Unleashed Guid — the join key
  supplierName: string;
  supplierCode?: string;
  contact: {
    email?: string;
    phone?: string;
    website?: string;
    address?: string;
  };
  paymentTerms?: string;         // "Net 30", "COD", etc.
  currency: string;              // "AUD" default
  notes?: string;
}

// The relationship — this is where your app adds value over Unleashed.
interface SupplyRelationship {
  id: string;
  ingredientCode: string;        // → Ingredient.productCode
  supplierId: string;            // → Supplier.supplierId
  unitPrice: number;
  priceCurrency: string;
  moq: number;                   // minimum order quantity in ingredient units
  leadTimeDays: number;          // working days
  preferred: boolean;            // primary supplier for this ingredient?
  active: boolean;
  lastVerifiedAt: string;        // ISO date — when was the price last confirmed
  notes?: string;
}

// Optional: track certifications at the ingredient–supplier level.
interface Certification {
  kind: 'organic' | 'kosher' | 'halal' | 'fairtrade' | 'bcorp' | string;
  issuedBy?: string;
  expiresAt?: string;            // ISO date
  documentUrl?: string;
}
```

Keep the schemas **flat and explicit**. Avoid nested optional chains that represent state machines — use a `status` field instead.

---

## 4. Shared primitives you should reuse

These live in `/src/lib/planning/` and `/src/lib/unleashed/` in the planner repo. When we integrate, they'll either be shared via a small npm package or directly referenced — either way, **match their shape**.

### 4.1 `working-day.ts` — time module

```typescript
// Every "date" in persisted/serialized data is a local ISO string.
toLocalISODate(date: Date): string       // "2026-04-20"
fromLocalISODate(iso: string): Date
dayIntToDate(dayInt: number): Date       // working-day integer scheme
dateToDayInt(date: Date): number
```

**Planning uses a "working-day integer" system** (1 = Mon this week, 6 = Mon next week, etc.) for any scheduling input. If your tracker displays delivery ETAs or contract renewals in that timeframe, use the same helpers so UI is consistent.

### 4.2 Unleashed types (`src/lib/unleashed/types.ts`)

If you fetch directly from Unleashed (recommended for Supplier + Product base entities), reuse these interfaces exactly. The HMAC auth + proxy route (`/api/unleashed`) is already set up in our repo — you can port the pattern.

### 4.3 `Demand` contract (`src/lib/planning/demand.ts`)

Your tracker *could* publish purchase demand back to the planner as typed `Demand[]`. The planner already has a `DemandStore` with pub/sub. Adding a new source is a 1-line change on the planner side once your tracker conforms.

### 4.4 `PlanItem` + `PlanDraftStore` (`src/lib/planning/plan-item.ts`, `plan-draft-store.ts`)

You probably don't need to literally import these, but **study the pattern**. One versioned localStorage key, discriminated union type, lazy legacy migration, session-guarded so it never re-fires. Adopt the same pattern for your own draft/work-in-progress state (e.g., a draft contract, an unsaved price update).

### 4.5 `WarehouseSOH` (`src/lib/planning/warehouse-soh.ts`)

If your app needs to display stock (it probably will — "how much of this ingredient do we have?"), consume the same class. It wraps the Unleashed SOH quirks (the per-warehouse fallback fetch) into one clean API:

```typescript
soh.atWarehouse('Lundberg Storeroom', 'WLN-RAW')   // number
soh.globalOnHand('WLN-RAW')                         // number
soh.perProduct('WLN-RAW')                           // Record<warehouseName, qty>
```

---

## 5. Storage & migrations

- **One versioned localStorage key per concern**, not one per feature. Example: `byron-tracker-suppliers-v1`, `byron-tracker-supply-relationships-v1`.
- Payload shape: `{ version: 1, items: T[] }`.
- **Migrate on first read**, then delete the old key. Session-guard with a module-level flag so it doesn't fight with a React effect that writes an empty array before the migration has completed. (This bit us in the planner — see `plan-draft-store.ts` for the pattern.)
- If the tracker grows to multi-device state, step through exactly once to a proper backend. Don't try to shard into "local vs. remote" — one source of truth wins every time.

---

## 6. Engine/UI split

When you write pricing math, MOQ satisfaction, cheapest-supplier logic, any of that:

1. Put the pure function in `src/lib/tracker-engine/*.ts`.
2. It takes typed input (domain types from §3).
3. It returns typed output.
4. No React, no hooks, no `Date.now()`, no `fetch()`.
5. Export a **wire shape** alongside if the function ever needs to run remotely. See `src/lib/engine/serialization.ts` in our repo — that's the pattern.
6. Hooks call the engine and manage React state; they don't inline the math.

This is what makes the engines portable. When you want to port a pricing comparator to Python later, the TS and Python versions share the exact JSON contract and can be tested for byte-equivalence.

---

## 7. Integration seams (how the two apps will talk)

Three options, in increasing ambition. Default to option A; adopt B or C when value crystallizes.

**A. Both read Unleashed independently.** Your tracker and our planner both use `productCode` and `supplierId` as join keys (they come from Unleashed). When the planner drafts a PO, it calls a lightweight endpoint you expose:

```
GET /api/tracker/supply/:productCode
→ {
    preferred: { supplierId, unitPrice, leadTimeDays, moq, priceCurrency },
    alternatives: [...],
    lastVerifiedAt: ISO
  }
```

**B. Shared npm package.** Extract the types in §3–§4 to `@byron/planning-primitives`. Both apps depend on it. Types stay in sync by construction.

**C. Unified state service.** Both apps hit one FastAPI / Supabase / whatever for canonical supplier + ingredient state. This is where Phase 6 of our refactor pays off — our engines already speak JSON, so swapping localStorage for a real backend is a narrow change.

**Don't start with C.** Start with A: use Unleashed identifiers, expose a JSON endpoint. Trust that the types are compatible because you followed this brief.

---

## 8. Anti-patterns we learned the hard way

Save yourself our pain. Do **not**:

- **Write domain state to multiple localStorage keys.** We had 6+ and spent a phase cleaning them up. One versioned key. Kind-discriminated items inside.
- **Let Unleashed shapes spread into UI code.** Adapt at the edge. Your tables and forms should never see `ProductGuid` or `OrderStatus = "Partialled"`.
- **Use `toISOString()` on business dates.** It converts to UTC; Australian dates get shifted back a day. Use `toLocalISODate()` from the planning module.
- **Type business calendars as `any`.** It looks pragmatic; three months later the type boundary is sieve. Our `BusinessCalendar` type kept getting `any`-cast until Phase 6 cleaned it up. Just declare the interface upfront.
- **Duplicate a dialog/component when "it's almost the same."** If you're copy-pasting 200 lines of 3-phase state machine, stop. Extract a parameterized component with an adapter pattern. We had 3 push dialogs; now we have one.
- **Build a compat layer "for safety."** You'll maintain it forever. One-shot migrations are scary for three days and liberating for the next year.

---

## 9. Suggested starter file structure

Mirror the planner's shape so file paths are predictable across apps:

```
src/
  app/
    ingredients/page.tsx         # List + detail
    suppliers/page.tsx
    supply/page.tsx              # The ingredient↔supplier matrix
    api/
      unleashed/route.ts         # Proxy — port from planner
      tracker-supply/route.ts    # The integration endpoint from §7 A
  lib/
    tracker/
      types.ts                   # §3 types
      ingredient-store.ts        # versioned localStorage store
      supplier-store.ts
      supply-store.ts
    tracker-engine/
      pricing.ts                 # pure pricing functions
      moq.ts                     # MOQ satisfaction math
      index.ts                   # barrel + wire contract
      serialization.ts           # JSON wire types
    planning/                    # shared primitives (copy or link)
      working-day.ts
    unleashed/
      client.ts                  # copy from planner
      types.ts
      auth.ts                    # HMAC signature
```

---

## 10. The one-sentence summary

> Unleashed IDs are the join, domain types own the middle, storage is one versioned key per concern, dates are ISO strings at boundaries, and pure engines have wire-format contracts.

Build to those five constraints and the two apps will integrate in an afternoon whenever we're ready.

---

*If anything's unclear, the planner's `/src/lib/planning/` and `/src/lib/engine/` directories are the reference implementation — read `plan-item.ts`, `plan-draft-store.ts`, `demand.ts`, and `engine/serialization.ts` in that order for the shortest path to internalizing the pattern.*

---

## Addendum: starter package

A shared-primitives package now exists at `packages/planning-primitives/` in this repo, implementing the types + helpers described above:

- `working-day` — time conversions (ported verbatim from the planner, byte-identical)
- `versioned-store` — `createVersionedStore<T>()` generalising the planner's `plan-draft-store` pattern, including the session-guarded migration trick
- `types` — `Ingredient`, `Supplier`, `SupplyRelationship`, `Demand`, branded join keys
- `wire` — `LocalISODate`, `WireSafe<T>`, `WireAdapter<In, Wire>`

See `packages/planning-primitives/README.md` for the quick-start. The package is self-contained (19 tests, no runtime dependencies) and ready to copy into the tracker repo or consume via path import during development.
