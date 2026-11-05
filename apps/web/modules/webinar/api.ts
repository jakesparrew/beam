/**
 * webinar's cross-module door (02-data-model section 6.12, webinar spec 4.7). Every function
 * another module calls in R2-R4 is declared here with its final signature; each takes the
 * caller's `db`/`tx` first (OD-15). Until its webinar package lands a function throws
 * `NotImplementedError('webinar.<fn>')`. webinar-P1 implemented `mergePersons`; webinar-P3 the
 * registration and discovery functions (`getWebinarForSession`, `listPublicWebinars`,
 * `listPersonWebinars`, `listUpcomingRegistrationsForPerson`, `getWebinarCards`, `getAccessUrl`,
 * `WebinarSignup`).
 *
 * Implementing packages: webinar-P3 (`getWebinarForSession`, `listPublicWebinars`,
 * `listPersonWebinars`, `listUpcomingRegistrationsForPerson`, `getWebinarCards`, `getAccessUrl`,
 * `WebinarSignup`), webinar-P6 (`getPersonWebinarStats`, `countWebinarLeadsWithoutBooking`,
 * `listWebinarLeadsWithoutBooking`, `listUpcomingWebinarHealth`), webinar-P7 (`getWebinarKpis`)
 * and webinar-P8 (`getWebinarWeeklyFacts`).
 */
import type { DbOrTx, Tx } from "@beam/db";
import { webinarPresenters, webinarRegistrations, webinars } from "@beam/db/schema";
import { NotImplementedError } from "@beam/core/errors";
import { URL_SEGMENT, type Locale, type LocalizedText } from "@beam/core/i18n";
import { titleIn, webinarLandingUrl } from "@beam/email/templates/webinar";
import { and, eq, inArray, notInArray, sql } from "@/lib/ctx";
import type { WatchMode, WebinarMode, WebinarStatus } from "@beam/core/webinar";
import { PUBLIC_STATUSES, isUpcoming, listPersonRegistrations, listPublicWebinarRows, type PersonRegistrationRow } from "./queries";
import { accessUrlOf } from "./server/registration";
import type { WebinarRow } from "./server/lifecycle";

export type { WatchMode, WebinarMode, WebinarStatus } from "@beam/core/webinar";

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`webinar.${fn}`));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type WebinarSummary = {
  id: string;
  slug: string;
  title: LocalizedText;
  mode: WebinarMode;
  status: WebinarStatus;
  startsAt: Date | null;
  sessionId: string | null;
  spokenLocale: Locale;
  landingPath: string;
};

export type PersonWebinarRow = {
  registrationId: string;
  webinarId: string;
  title: LocalizedText;
  mode: WebinarMode;
  registeredMode: WatchMode;
  status: "registered" | "cancelled" | "blocked";
  startsAt: Date | null;
  watchedSec: Record<WatchMode, number>;
  attended: Record<WatchMode, boolean>;
};

export type PersonWebinarStats = {
  webinarsRegistered: number;
  webinarsAttendedLive: number;
  replaysWatched: number;
  onDemandWatched: number;
  watchSecTotal: number;
  pollAnswers: number;
  ctaClicks: number;
  lastRegisteredAt: Date | null;
  lastAttendedAt: Date | null;
};

export type WebinarKpis = {
  webinars: number;
  registrations: number;
  liveAttendanceRate: number;
  replayViewRate: number;
  conversionRate: number;
  revenueCents: number;
  bySegment: Record<"lead" | "customer" | "member", { registrations: number; attended: number; converted: number }>;
  byUtmCampaign: Array<{ campaign: string | null; registrations: number; attended: number; converted: number }>;
};

function summaryOf(w: WebinarRow, locale: Locale): WebinarSummary {
  return {
    id: w.id,
    slug: w.slug,
    title: w.title as LocalizedText,
    mode: w.mode,
    status: w.status,
    startsAt: w.startsAt,
    sessionId: w.sessionId,
    spokenLocale: w.spokenLocale,
    landingPath: `/${URL_SEGMENT[locale]}/webinars/${w.slug}`,
  };
}

function personRowOf(x: PersonRegistrationRow): PersonWebinarRow {
  return {
    registrationId: x.registration.id,
    webinarId: x.webinar.id,
    title: x.webinar.title as LocalizedText,
    mode: x.webinar.mode,
    registeredMode: x.registration.registeredMode,
    status: x.registration.status,
    startsAt: x.webinar.startsAt,
    watchedSec: x.watchedSec,
    attended: x.attended,
  };
}

export type WebinarCard = { id: string; slug: string; title: string; mode: WebinarMode; startsAt: Date | null; spokenLocale: Locale; landingUrl: string };

export async function getWebinarForSession(db: DbOrTx, sessionId: string): Promise<WebinarSummary | null> {
  const [w] = await db.select().from(webinars).where(and(eq(webinars.sessionId, sessionId), inArray(webinars.status, [...PUBLIC_STATUSES])));
  return w ? summaryOf(w, w.spokenLocale) : null;
}

/** Upcoming and live webinars, then on-demand ones, offered in `locale` (section 5.3). */
export async function listPublicWebinars(db: DbOrTx, opts: { locale: Locale; from: Date; limit: number }): Promise<WebinarSummary[]> {
  return (await listPublicWebinarRows(db, opts)).map((w) => summaryOf(w, opts.locale));
}

/** Every registration of the person (and of persons merged into them), newest first (crm person card). */
export async function listPersonWebinars(db: DbOrTx, personId: string): Promise<PersonWebinarRow[]> {
  return (await listPersonRegistrations(db, personId)).map(personRowOf);
}

export function getPersonWebinarStats(_db: DbOrTx, _personId: string): Promise<PersonWebinarStats> {
  return notYet("getPersonWebinarStats");
}

/** Absolute https URL `/<l>/w/<token>` at the registration's current `token_version`. */
export function getAccessUrl(db: DbOrTx, registrationId: string, locale: Locale): Promise<string> {
  return accessUrlOf(db, registrationId, locale);
}

/**
 * crm's merge hook (edge case 19, cross-module decision 19), called before crm's generic repoint
 * (`webinar_registrations` is `skip` there). A loser registration for a webinar the winner is not
 * registered for is repointed to the winner (`moved`). When both are registered, the loser's
 * registration stays on the loser id with its append-only segments and interactions
 * (`collapsed`); the views fold it into the winner through `persons.merged_into_person_id`.
 * Nothing in an append-only table is touched and `beam.allow_rewrite` is never set.
 *
 * Presenter rows (mutable) are settled here too, so the generic repoint never meets the
 * presenter identity index: the loser's row moves to the winner, or is dropped when the winner
 * already presents that webinar.
 */
export async function mergePersons(tx: Tx, winnerPersonId: string, loserPersonId: string): Promise<{ moved: number; collapsed: number }> {
  if (winnerPersonId === loserPersonId) return { moved: 0, collapsed: 0 };
  const winnerWebinars = tx
    .select({ id: webinarRegistrations.webinarId })
    .from(webinarRegistrations)
    .where(eq(webinarRegistrations.personId, winnerPersonId));
  const moved = await tx
    .update(webinarRegistrations)
    .set({ personId: winnerPersonId, updatedAt: new Date() })
    .where(and(eq(webinarRegistrations.personId, loserPersonId), notInArray(webinarRegistrations.webinarId, winnerWebinars)))
    .returning({ id: webinarRegistrations.id });
  const [left] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(webinarRegistrations)
    .where(eq(webinarRegistrations.personId, loserPersonId));

  const winnerPresents = tx
    .select({ id: webinarPresenters.webinarId })
    .from(webinarPresenters)
    .where(eq(webinarPresenters.personId, winnerPersonId));
  await tx
    .delete(webinarPresenters)
    .where(and(eq(webinarPresenters.personId, loserPersonId), inArray(webinarPresenters.webinarId, winnerPresents)));
  await tx
    .update(webinarPresenters)
    .set({ personId: winnerPersonId, updatedAt: new Date() })
    .where(eq(webinarPresenters.personId, loserPersonId));

  return { moved: moved.length, collapsed: Number(left?.n ?? 0) };
}

/** R3. */
export function getWebinarKpis(_db: DbOrTx, _input: { from: Date; to: Date; periodDays: number }): Promise<WebinarKpis> {
  return notYet("getWebinarKpis");
}

/** R4. */
export function getWebinarWeeklyFacts(_db: DbOrTx, _weekStart: Date): Promise<Array<{ fact: string; value: number }>> {
  return notYet("getWebinarWeeklyFacts");
}

export function countWebinarLeadsWithoutBooking(_db: DbOrTx, _input: { startedSince: Date }): Promise<number> {
  return notYet("countWebinarLeadsWithoutBooking");
}

export function listWebinarLeadsWithoutBooking(
  _db: DbOrTx,
  _input: { startedSince: Date; limit: number },
): Promise<Array<{ personId: string; webinarId: string; registeredAt: Date }>> {
  return notYet("listWebinarLeadsWithoutBooking");
}

/** Email `webinar` block (email-P8); unknown, draft, cancelled and archived ids are left out; order follows `ids`. */
export async function getWebinarCards(tx: DbOrTx, ids: string[], locale: Locale): Promise<WebinarCard[]> {
  const wanted = [...new Set(ids.filter((id) => UUID.test(id)))];
  if (!wanted.length) return [];
  const rows = await tx.select().from(webinars).where(and(inArray(webinars.id, wanted), inArray(webinars.status, [...PUBLIC_STATUSES])));
  const byId = new Map(rows.map((w) => [w.id, w]));
  return wanted.flatMap((id) => {
    const w = byId.get(id);
    if (!w) return [];
    return [
      {
        id: w.id,
        slug: w.slug,
        title: titleIn(w.title as Record<string, string>, locale),
        mode: w.mode,
        startsAt: w.startsAt,
        spokenLocale: w.spokenLocale,
        landingUrl: webinarLandingUrl(w.slug, locale),
      },
    ];
  });
}

/** The person's `registered` webinars that are still to come or live, soonest first (site account home). */
export async function listUpcomingRegistrationsForPerson(db: DbOrTx, personId: string): Promise<PersonWebinarRow[]> {
  const now = new Date();
  return (await listPersonRegistrations(db, personId))
    .filter((x) => x.registration.status === "registered" && isUpcoming(x.webinar, now))
    .sort((a, b) => (a.webinar.startsAt?.getTime() ?? 0) - (b.webinar.startsAt?.getTime() ?? 0))
    .map(personRowOf);
}

export function listUpcomingWebinarHealth(
  _db: DbOrTx,
  _within: { hours: 48 },
): Promise<
  Array<{ webinarId: string; title: string; startsAt: Date; mode: WebinarMode; youtubeLifecycle: string | null; broadcastError: string | null; registrations: number }>
> {
  return notYet("listUpcomingWebinarHealth");
}

/** Server component `{ webinarId, locale }` for site's `webinar_signup` block. */
export { WebinarSignup } from "./ui/webinar-signup";
