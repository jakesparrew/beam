/**
 * booking permissions (architecture section 4, 02-data-model 5.3, booking spec 7). Facade read by
 * `pnpm gen:indexes`. This module declares no new permission string: it registers the use of the
 * four below and borrows `settings.write` (templates, exceptions, rules), `partner.own` (R3
 * partner holds) and `reports.read` (ops' reports over booking data), declared by their owners.
 */
export const permissions = ["bookings.read", "bookings.write", "bookings.override", "waitlist.manage"] as const;
