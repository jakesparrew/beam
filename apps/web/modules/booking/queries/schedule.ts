/**
 * booking queries, area `schedule` (booking spec 4.3). Created empty by booking-P1; booking-P2 adds
 * here: listSessionsInRange, getDayView, getSessionDetail, listTemplates, getTemplate, listExceptions, getDayPrintList, listUpcomingHolidays, getOpeningHours. Staff queries call `requirePermission`; customer queries are scoped to
 * `ctx.actor.personId`. Other modules never import this file (they use `../api.ts`).
 */
export {};
