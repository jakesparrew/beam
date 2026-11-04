"use server";
/**
 * booking server actions, area `sessions` (booking spec 4.2). Created empty by booking-P1;
 * booking-P2 adds here: createSession, updateSession, publishSession, setSessionOpen, upsertHold, deleteHold (cancelSession lives in actions/bookings.ts). Every action goes through `action()` from `@/lib/action`; a
 * "use server" file exports async functions only, so Zod inputs stay unexported.
 */
export {};
