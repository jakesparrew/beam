"use server";
/**
 * ops server actions, area `stats`: person stats, inactivity and stage events, the daily digest (ops spec 4.1). Created empty by ops-P1;
 * ops-P2 adds here: recalculatePersonStats. Every action goes through `action()` from `@/lib/action`
 * with its Zod input from `@beam/core/ops`; a "use server" file exports async functions only.
 */
export {};
