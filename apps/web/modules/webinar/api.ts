/**
 * webinar's cross-module door (02-data-model section 6.12, webinar spec 4.7). Every function
 * another module calls in R2-R4 is declared here with its final signature; each takes the
 * caller's `db`/`tx` first (OD-15). Until its webinar package lands a function throws
 * `NotImplementedError('webinar.<fn>')`, except `listPublicWebinars` (an empty list; site-P3
 * calls it in V1) and `mergePersons`, implemented by webinar-P1 now that the tables exist.
 *
 * Implementing packages: webinar-P3 (`getWebinarForSession`, `listPublicWebinars`,
 * `listPersonWebinars`, `listUpcomingRegistrationsForPerson`, `getWebinarCards`, `getAccessUrl`,
 * `WebinarSignup`), webinar-P6 (`getPersonWebinarStats`, `countWebinarLeadsWithoutBooking`,
 * `listWebinarLeadsWithoutBooking`, `listUpcomingWebinarHealth`), webinar-P7 (`getWebinarKpis`)
 * and webinar-P8 (`getWebinarWeeklyFacts`).
 */
import type { DbOrTx, Tx } from "@beam/db";
import { webinarPresenters, webinarRegistrations } from "@beam/db/schema";
import { NotImplementedError } from "@beam/core/errors";
import type { Locale, LocalizedText } from "@beam/core/i18n";
import { and, eq, inArray, notInArray, sql } from "@/lib/ctx";
import type { WatchMode, WebinarMode, WebinarStatus } from "@beam/core/webinar";

export type { WatchMode, WebinarMode, WebinarStatus } from "@beam/core/webinar";

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`webinar.${fn}`));

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

export type WebinarCard = { id: string; slug: string; title: string; mode: WebinarMode; startsAt: Date | null; spokenLocale: Locale; landingUrl: string };

export function getWebinarForSession(_db: DbOrTx, _sessionId: string): Promise<WebinarSummary | null> {
  return notYet("getWebinarForSession");
}

/** Does not throw before R2: no webinar exists yet, so the list is empty. */
export function listPublicWebinars(_db: DbOrTx, _opts: { locale: Locale; from: Date; limit: number }): Promise<WebinarSummary[]> {
  return Promise.resolve([]);
}

export function listPersonWebinars(_db: DbOrTx, _personId: string): Promise<PersonWebinarRow[]> {
  return notYet("listPersonWebinars");
}

export function getPersonWebinarStats(_db: DbOrTx, _personId: string): Promise<PersonWebinarStats> {
  return notYet("getPersonWebinarStats");
}

/** Absolute https URL `/<l>/w/<token>`. */
export function getAccessUrl(_db: DbOrTx, _registrationId: string, _locale: Locale): Promise<string> {
  return notYet("getAccessUrl");
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

/** Email `webinar` block; order follows `ids`. */
export function getWebinarCards(_tx: DbOrTx, _ids: string[], _locale: Locale): Promise<WebinarCard[]> {
  return notYet("getWebinarCards");
}

export function listUpcomingRegistrationsForPerson(_db: DbOrTx, _personId: string): Promise<PersonWebinarRow[]> {
  return notYet("listUpcomingRegistrationsForPerson");
}

export function listUpcomingWebinarHealth(
  _db: DbOrTx,
  _within: { hours: 48 },
): Promise<
  Array<{ webinarId: string; title: string; startsAt: Date; mode: WebinarMode; youtubeLifecycle: string | null; broadcastError: string | null; registrations: number }>
> {
  return notYet("listUpcomingWebinarHealth");
}

/** Server component `{ webinarId, locale }` for site's `webinar_signup` block (Wave 0 stand-in). */
export function WebinarSignup(_props: { webinarId: string; locale: Locale }): never {
  throw new NotImplementedError("webinar.WebinarSignup");
}
