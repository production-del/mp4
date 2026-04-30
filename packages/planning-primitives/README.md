# @byron/planning-primitives

Shared types, time helpers, storage patterns, and wire conventions for Byron Co-op apps.

Consumed by:
- **byron-planner** — production planner (Kitchen / Packaging / Purchasing / Logistics)
- **byron-tracker** — supplier + ingredient tracker (new)
- Future Byron apps

## What's in the box

| Module | What it gives you |
|---|---|
| `working-day` | `dayInt ↔ Date ↔ ISO` conversions, local-timezone-safe. **Never call `toISOString()` on business dates.** |
| `versioned-store` | `createVersionedStore<T>()` — localStorage with versioned schemas + session-guarded migration. |
| `types` | `Ingredient`, `Supplier`, `SupplyRelationship`, `Demand`, branded `ProductCode` / `SupplierId` / `WarehouseId`. |
| `wire` | `LocalISODate`, `WireSafe<T>`, `WireAdapter<In, Wire>` — the JSON-safe contract types. |

## Install (future)

```bash
npm install @byron/planning-primitives
```

For now the package lives in `packages/planning-primitives/` inside the planner repo. Copy or path-link it into the consuming app until it's published to a registry.

## Quick start

### Time

```ts
import { dayIntToDate, toLocalISODate, dayIntToReadable } from '@byron/planning-primitives';

const date = dayIntToDate(7);                // "next Tuesday"
const iso = toLocalISODate(date);            // "2026-04-21"
const label = dayIntToReadable(7);           // "Tue, Next wk"
```

### Versioned store

```ts
import { createVersionedStore } from '@byron/planning-primitives';
import type { Ingredient } from '@byron/planning-primitives/types';

const ingredientStore = createVersionedStore<Ingredient>({
  key: 'byron-tracker-ingredients-v1',
  version: 1,
  migrateLegacy: () => {
    // Read whatever the old shape was; delete the old key on the way out.
    const raw = localStorage.getItem('byron-tracker-ingredients');
    if (!raw) return [];
    localStorage.removeItem('byron-tracker-ingredients');
    return JSON.parse(raw);
  },
});

ingredientStore.list();
ingredientStore.upsert(
  { productCode: ProductCode('WLN-RAW'), productName: 'Walnuts', category: 'raw_material', unitOfMeasure: 'kg' },
  (a, b) => a.productCode === b.productCode,
);
```

### Types

```ts
import type { Ingredient, Supplier, SupplyRelationship } from '@byron/planning-primitives/types';
import { ProductCode, SupplierId } from '@byron/planning-primitives/types';

const ingredient: Ingredient = {
  productCode: ProductCode('WLN-RAW'),
  productName: 'Walnuts (Raw, Organic)',
  category: 'raw_material',
  unitOfMeasure: 'kg',
};

const relationship: SupplyRelationship = {
  id: 'WLN-RAW::sup-abc123',
  ingredientCode: ProductCode('WLN-RAW'),
  supplierId: SupplierId('sup-abc123'),
  unitPrice: 18.5,
  priceCurrency: 'AUD',
  moq: 25,
  leadTimeDays: 7,
  preferred: true,
  active: true,
  lastVerifiedAt: '2026-04-17',
};
```

### Wire contract

```ts
import type { WireSafe, WireAdapter, LocalISODate } from '@byron/planning-primitives/wire';
import { toLocalISODate, fromLocalISODate } from '@byron/planning-primitives';

interface PricingRequest {
  productCode: string;
  asOf: Date;                  // in-memory
}

interface PricingRequestWire {
  productCode: string;
  asOf: LocalISODate;          // wire
}

const pricingAdapter: WireAdapter<PricingRequest, PricingRequestWire> = {
  toWire: (r) => ({ ...r, asOf: toLocalISODate(r.asOf) }),
  fromWire: (w) => ({ ...w, asOf: fromLocalISODate(w.asOf) }),
};
```

## Design principles

See `docs/INTEGRATION-BRIEF.md` in the planner repo for the full philosophy. The short version:

1. Unleashed is an adapter at the edge, not your core model.
2. Canonical inputs, never derived ones.
3. One type per concept, discriminated unions for variants.
4. ISO strings everywhere except React state.
5. Pure engines with wire-format contracts.
6. One-shot migrations, clean breaks.

## Development

```bash
npm install
npm run check       # tsc --noEmit
npm test            # vitest run
npm run build       # emits dist/
```

## Versioning

While in early development, the major version stays `0.x` and the minor version bumps on every breaking change. Treat any `0.x` → `0.(x+1)` as requiring a migration plan.

## Repo location

`packages/planning-primitives/` inside the `masterv3` (planner) repo. When a second consumer lands, extract to its own repo or publish to a private registry.
