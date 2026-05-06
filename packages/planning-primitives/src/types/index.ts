/**
 * Shared domain types across Byron apps.
 *
 * These are the minimum types two apps need to agree on to integrate. Each
 * app will extend them with its own internal types; these are the
 * boundary/handoff shapes.
 */

export * from './join-keys';
export * from './ingredient';
export * from './supplier';
export * from './supply-relationship';
export * from './demand';
