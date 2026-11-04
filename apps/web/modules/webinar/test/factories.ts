/**
 * webinar test factories (webinar-P1). Every webinar test builds its rows here, on top of the
 * shared factories of `@beam/db/testing` (persons, users, sessions), so later packages and
 * other modules' tests create webinar rows the same way.
 *
 * - `makeWebinar(db, overrides?, opts?)`: a draft live webinar starting tomorrow at 19:00 UTC;
 *   `opts.published` makes it publishable for its mode (session for live and simulive, broadcast
 *   id for live, recording and duration for simulive and on-demand).
 * - `makeRegistration(db, { webinarId, ... })`: a `registered` live registration of a new
 *   person with a real access token (`token`) and its stored hash.
 * - `makeSegments(db, registration, mode, spans, opts?)`: `watch_segments` rows of one view.
 * - `makePoll`, `makeCta`: an active two-option poll and an https CTA.
 */
import { randomUUID } from "node:crypto";
import type { DbOrTx } from "@beam/db";
import { watchSegments, webinarCtas, webinarPolls, webinarRegistrations, webinars } from "@beam/db/schema";
import { makePerson, makeSession, makeUser } from "@beam/db/testing";
import { deriveAccessKey, hashAccessToken, signAccessToken, type WatchMode } from "@beam/core/webinar";

export type WebinarRow = typeof webinars.$inferSelect;
export type WebinarInsert = typeof webinars.$inferInsert;
export type RegistrationRow = typeof webinarRegistrations.$inferSelect;
export type RegistrationInsert = typeof webinarRegistrations.$inferInsert;
export type PollRow = typeof webinarPolls.$inferSelect;
export type CtaRow = typeof webinarCtas.$inferSelect;
export type SegmentRow = typeof watchSegments.$inferSelect;

/** The secret test tokens are signed with (the app's `AUTH_SECRET` when the test env sets one). */
export const TEST_AUTH_SECRET = process.env.AUTH_SECRET ?? "webinar-test-auth-secret-0123456789abcdef";

export const WEBINAR_TITLE = { "nl-BE": "Beter slapen", "fr-BE": "Mieux dormir", en: "Sleep better" };
export const WEBINAR_DESCRIPTION = {
  "nl-BE": "Een avond over slaap en herstel.",
  "fr-BE": "Une soirée sur le sommeil et la récupération.",
  en: "An evening about sleep and recovery.",
};
const LABELS = {
  yes: { "nl-BE": "Ja", "fr-BE": "Oui", en: "Yes" },
  no: { "nl-BE": "Nee", "fr-BE": "Non", en: "No" },
};
/** A valid 11-character YouTube id. */
export const FAKE_VIDEO_ID = "dQw4w9WgXcQ";

let counter = 0;
const unique = () => `${Date.now().toString(36)}${(++counter).toString(36)}`;

/** Tomorrow at 19:00 UTC (a typical evening webinar). */
export function tomorrowEvening(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 19));
}

export async function makeWebinar(db: DbOrTx, overrides: Partial<WebinarInsert> = {}, opts: { published?: boolean } = {}): Promise<WebinarRow> {
  const mode = overrides.mode ?? "live";
  const ownerUserId = overrides.ownerUserId ?? (await makeUser(db)).id;
  const startsAt = overrides.startsAt !== undefined ? overrides.startsAt : mode === "on_demand" ? null : tomorrowEvening();
  const values: WebinarInsert = {
    slug: `webinar-${unique()}`,
    title: WEBINAR_TITLE,
    description: WEBINAR_DESCRIPTION,
    mode,
    startsAt,
    ownerUserId,
    createdByUserId: overrides.createdByUserId ?? ownerUserId,
  };
  if (opts.published) {
    Object.assign(values, { status: "published", publishedAt: new Date() });
    if (mode !== "on_demand" && overrides.sessionId === undefined) {
      const start = startsAt ?? tomorrowEvening();
      const session = await makeSession(db, {
        kind: "event",
        creditKind: null,
        eventCategory: "webinar",
        capacitySeats: 0,
        startsAt: start,
        endsAt: new Date(start.getTime() + 60 * 60_000),
      });
      values.sessionId = session.id;
    }
    if (mode === "live") values.youtubeVideoId = FAKE_VIDEO_ID;
    else Object.assign(values, { recordingVideoId: FAKE_VIDEO_ID, durationSec: 3600 });
  }
  const [row] = await db
    .insert(webinars)
    .values({ ...values, ...overrides })
    .returning();
  return row!;
}

/** A registration plus its raw access token (`token`), signed with `TEST_AUTH_SECRET`. */
export async function makeRegistration(
  db: DbOrTx,
  input: Partial<RegistrationInsert> & { webinarId: string },
): Promise<RegistrationRow & { token: string }> {
  const id = input.id ?? randomUUID();
  const version = input.tokenVersion ?? 1;
  const token = signAccessToken(deriveAccessKey(TEST_AUTH_SECRET), id, version);
  const personId = input.personId ?? (await makePerson(db)).id;
  const status = input.status ?? "registered";
  const [row] = await db
    .insert(webinarRegistrations)
    .values({
      id,
      personId,
      accessTokenHash: hashAccessToken(token),
      tokenVersion: version,
      registeredMode: "live",
      status,
      source: "site",
      locale: "nl-BE",
      personStatus: "lead",
      ...(status === "cancelled" ? { cancelledAt: new Date() } : {}),
      ...(status === "blocked" ? { blockedAt: new Date() } : {}),
      ...input,
    })
    .returning();
  return { ...row!, token };
}

/**
 * `watch_segments` rows of one view (`[fromSec, toSec]` pairs, each at most 30 s). `recordedAt`
 * defaults to now; `stepMs` spaces the rows like heartbeats.
 */
export async function makeSegments(
  db: DbOrTx,
  registration: { id: string; webinarId: string },
  mode: WatchMode,
  spans: ReadonlyArray<readonly [number, number]>,
  opts: { viewId?: string; recordedAt?: Date; stepMs?: number } = {},
): Promise<SegmentRow[]> {
  if (!spans.length) return [];
  const viewId = opts.viewId ?? randomUUID();
  const start = (opts.recordedAt ?? new Date()).getTime();
  const step = opts.stepMs ?? 0;
  return db
    .insert(watchSegments)
    .values(
      spans.map(([fromSec, toSec], i) => ({
        registrationId: registration.id,
        webinarId: registration.webinarId,
        mode,
        viewId,
        fromSec,
        toSec,
        recordedAt: new Date(start + i * step),
      })),
    )
    .returning();
}

/** Consecutive 15-second spans covering `[fromSec, toSec)` (a heartbeat stream). */
export function heartbeatSpans(fromSec: number, toSec: number, stepSec = 15): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let s = fromSec; s < toSec; s += stepSec) out.push([s, Math.min(toSec, s + stepSec)]);
  return out;
}

export async function makePoll(db: DbOrTx, input: Partial<typeof webinarPolls.$inferInsert> & { webinarId: string }): Promise<PollRow> {
  const [row] = await db
    .insert(webinarPolls)
    .values({
      key: `poll_${unique()}`.slice(0, 40).toLowerCase(),
      question: { "nl-BE": "Slaap je goed?", "fr-BE": "Dormez-vous bien ?", en: "Do you sleep well?" },
      options: [
        { key: "yes", label: LABELS.yes },
        { key: "no", label: LABELS.no },
      ],
      ...input,
    })
    .returning();
  return row!;
}

export async function makeCta(db: DbOrTx, input: Partial<typeof webinarCtas.$inferInsert> & { webinarId: string }): Promise<CtaRow> {
  const [row] = await db
    .insert(webinarCtas)
    .values({
      key: `cta_${unique()}`.slice(0, 40).toLowerCase(),
      label: { "nl-BE": "Boek een sessie", "fr-BE": "Réservez une séance", en: "Book a session" },
      url: "https://beam.example.com/book",
      ...input,
    })
    .returning();
  return row!;
}
