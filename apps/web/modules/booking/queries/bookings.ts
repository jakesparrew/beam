/**
 * booking queries, area `bookings` (booking spec 4.3). Created empty by booking-P1; booking-P3a adds
 * here: listBookings, getBooking, getUtilisation and the customer queries listBookableSessions, getBookableSession, listMyBookings, getMyBooking, listRescheduleTargets. Staff queries call `requirePermission`; customer queries are scoped to
 * `ctx.actor.personId`. Other modules never import this file (they use `../api.ts`).
 */
export {};
