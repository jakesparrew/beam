/**
 * ops server actions (ops spec 4.1): a barrel over the area files `<area>/actions.ts`, written
 * once by ops-P1 so the ops packages that run in parallel never edit the same file. Each area
 * file is a "use server" module; this barrel only re-exports.
 */
export * from "./stats/actions";
export * from "./dashboard/actions";
export * from "./reports/actions";
export * from "./imports/actions";
export * from "./exports/actions";
export * from "./privacy/actions";
export * from "./retention/actions";
export * from "./marketing/actions";
export * from "./insights/actions";
export * from "./ai/actions";
