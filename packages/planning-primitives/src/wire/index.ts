/**
 * Wire-format conventions for crossing a service boundary.
 *
 * When a payload crosses any boundary — localStorage, URL, fetch, message
 * queue, another language — it must be JSON-safe. The rules:
 *
 *   - Dates → `LocalISODate` strings (`YYYY-MM-DD`). Never `Date` objects;
 *     never `toISOString()` output (UTC-shifted).
 *   - IDs → plain strings (brand types unbrand automatically in JSON).
 *   - Enums → string literal unions, not TypeScript `enum` (which compiles
 *     to numbers and leaks implementation).
 *   - Maps → objects keyed by string.
 *   - No functions, no classes, no `undefined` top-level (use omitted keys).
 *
 * A type is "wire-safe" when every leaf is a primitive, a plain object, or
 * an array of the same. `WireSafe<T>` is a helper that tells the compiler
 * whether a type qualifies.
 */

/** A local-ISO date string: `YYYY-MM-DD`, interpreted in the app's timezone. */
export type LocalISODate = string;

/**
 * Recursively checks that a type contains only JSON-safe leaves. Useful as a
 * constraint on engine input/output types:
 *
 *     function toJSON<T>(input: WireSafe<T>): string { return JSON.stringify(input); }
 *
 * `Date` and `Map` trigger a type error; primitive objects pass.
 */
export type WireSafe<T> =
  T extends Date ? never
  : T extends Map<unknown, unknown> ? never
  : T extends Set<unknown> ? never
  : T extends Function ? never  // eslint-disable-line @typescript-eslint/no-unsafe-function-type
  : T extends Array<infer U> ? Array<WireSafe<U>>
  : T extends object ? { [K in keyof T]: WireSafe<T[K]> }
  : T;

/**
 * Convention: every engine function that may cross a boundary ships with a
 * matching `toWire*` / `fromWire*` pair. Encode this as an interface so
 * shared engine modules can declare conformance.
 *
 * Example:
 *
 *     const pricingAdapter: WireAdapter<PricingRequest, PricingRequestWire> = {
 *       toWire: (req) => ({ ...req, asOf: toLocalISODate(req.asOf) }),
 *       fromWire: (w) => ({ ...w, asOf: fromLocalISODate(w.asOf) }),
 *     };
 */
export interface WireAdapter<InMemory, Wire> {
  toWire: (input: InMemory) => Wire;
  fromWire: (wire: Wire) => InMemory;
}
