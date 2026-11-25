/**
 * Owner requirement 5: the registrations of an event or WebinarGeek webinar, for the staff CSV
 * export that is imported into WebinarGeek (`/admin/sessions/[id]/registrations.csv`), and what a
 * booked person gets in the portal (`getEventAccess`). Live seats only (confirmed, attended,
 * no-show). No sensitive data.
 */
import type { DbOrTx } from "@beam/db";
import { bookings, files, persons, sessions } from "@beam/db/schema";
import { and, asc, eq, inArray } from "@/lib/ctx";
import { MAX_TTL_SECONDS, signFileUrl } from "@/lib/files";

/** CSV columns; `firstname`, `surname` and `email` are the ones WebinarGeek's import maps. */
export const EVENT_REGISTRATION_COLUMNS = ["firstname", "surname", "email", "language", "status", "paid_with", "booked_at", "webinargeek_registered"] as const;

export async function listEventRegistrations(db: DbOrTx, sessionId: string): Promise<unknown[][]> {
  const rows = await db
    .select({
      firstName: persons.firstName,
      lastName: persons.lastName,
      email: persons.email,
      locale: persons.locale,
      status: bookings.status,
      paidWith: bookings.paidWith,
      createdAt: bookings.createdAt,
      watchUrl: bookings.webinarGeekWatchUrl,
    })
    .from(bookings)
    .innerJoin(persons, eq(persons.id, bookings.personId))
    .where(and(eq(bookings.sessionId, sessionId), inArray(bookings.status, ["confirmed", "attended", "no_show"])))
    .orderBy(asc(bookings.createdAt), asc(bookings.id));
  return rows.map((r) => [r.firstName ?? "", r.lastName ?? "", r.email ?? "", r.locale, r.status, r.paidWith, r.createdAt.toISOString(), r.watchUrl !== null ? "yes" : "no"]);
}

/**
 * Owner requirement 5, portal booking page: the WebinarGeek link of a live seat (the personal
 * watch link once registered through the API, else the webinar's link) and the materials once staff
 * released them, each as a signed download link (7 days). Empty for other sessions and ended seats.
 */
export async function getEventAccess(db: DbOrTx, bookingId: string): Promise<{ joinUrl: string | null; materials: Array<{ name: string; url: string }> }> {
  const none = { joinUrl: null, materials: [] };
  const [row] = await db
    .select({
      status: bookings.status,
      watchUrl: bookings.webinarGeekWatchUrl,
      webinarUrl: sessions.webinarGeekUrl,
      fileIds: sessions.materialFileIds,
      releasedAt: sessions.materialsReleasedAt,
    })
    .from(bookings)
    .innerJoin(sessions, eq(sessions.id, bookings.sessionId))
    .where(eq(bookings.id, bookingId));
  if (!row || !["confirmed", "attended", "no_show"].includes(row.status)) return none;
  const joinUrl = row.watchUrl || row.webinarUrl || null;
  if (!row.releasedAt || row.fileIds.length === 0) return { joinUrl, materials: [] };
  const found = await db.select({ id: files.id, name: files.name }).from(files).where(inArray(files.id, row.fileIds));
  const materials = row.fileIds.flatMap((id) => found.filter((f) => f.id === id)).map((f) => ({ name: f.name, url: signFileUrl(f.id, MAX_TTL_SECONDS) }));
  return { joinUrl, materials };
}
