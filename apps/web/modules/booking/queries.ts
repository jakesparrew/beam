/**
 * booking queries (booking spec 4.3): a barrel over the area files in `queries/` (decision 12).
 * Only booking's own screens import it; other modules read booking through `api.ts`.
 */
export * from "./queries/schedule";
export * from "./queries/bookings";
export * from "./queries/attendance";
export * from "./queries/waitlist";
export * from "./queries/partner";
