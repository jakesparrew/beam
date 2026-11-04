/**
 * booking server actions (booking spec 4.2): a barrel over the area files in `actions/`, so the
 * booking packages that run in parallel never edit the same file (decision 12). Each area file
 * is a "use server" module; this barrel only re-exports.
 */
export * from "./actions/templates";
export * from "./actions/sessions";
export * from "./actions/bookings";
export * from "./actions/attendance";
export * from "./actions/waitlist";
export * from "./actions/lead";
export * from "./actions/tickets";
export * from "./actions/partner";
