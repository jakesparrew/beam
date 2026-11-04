/**
 * ops queries (ops spec 4.2): a barrel over the area files `<area>/queries.ts`, written once by
 * ops-P1. Only ops' own screens import it; other modules read ops through `api.ts`.
 */
export * from "./stats/queries";
export * from "./dashboard/queries";
export * from "./reports/queries";
export * from "./imports/queries";
export * from "./exports/queries";
export * from "./privacy/queries";
export * from "./retention/queries";
export * from "./marketing/queries";
export * from "./insights/queries";
export * from "./ai/queries";
