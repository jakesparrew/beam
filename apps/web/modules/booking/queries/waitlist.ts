/**
 * booking queries, area `waitlist` (booking spec 4.3). Created empty by booking-P1; booking-P5 adds
 * here: listWaitlist, listMyWaitlist, getClaimOffer. Staff queries call `requirePermission`; customer queries are scoped to
 * `ctx.actor.personId`. Other modules never import this file (they use `../api.ts`).
 */
export {};
