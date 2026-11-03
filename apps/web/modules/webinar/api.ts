/**
 * webinar's cross-module door (02-data-model section 6.12). Wave 0 stubs by platform-P7 with the
 * owner's final signatures: each throws `NotImplementedError('webinar.<fn>')` until webinar
 * implements it (R2), except `mergePersons` and `listPublicWebinars`, which crm-P4 and site-P3
 * call in V1 before any webinar package exists (build order, forward-call stubs).
 */
import type { DbOrTx, Tx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { Locale, LocalizedText } from "@beam/core/i18n";
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

/** crm merge hook (edge case 19). Does not throw before R2: there are no registrations to move. */
export function mergePersons(_tx: Tx, _winnerPersonId: string, _loserPersonId: string): Promise<{ moved: number; collapsed: number }> {
  return Promise.resolve({ moved: 0, collapsed: 0 });
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
