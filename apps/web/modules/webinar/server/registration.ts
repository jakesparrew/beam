/**
 * Registration and access links (webinar spec rules 14-20, section 4.2; webinar-P3).
 *
 * Every registration path (site form, portal, staff, automation) calls `registerPerson`, which
 * runs in the caller's transaction:
 *
 * - `insert ... on conflict (webinar_id, person_id) do nothing`, then `select ... for update` of
 *   the row, so two concurrent registrations of one person end in one row and one
 *   `webinar.registered` event (rule 14). A new row snapshots `crm.getPersonStatus` (rule 16) and
 *   the `registered_mode` of rule 15; registering is refused (`webinar.register.closed`) when
 *   `canRegister` says so.
 * - Registering again returns the same row: `cancelled` becomes `registered` again with a fresh
 *   `webinar.registered` (dedupe `...:after:<previous cancelled_at minute>`, so the reminder
 *   journey enrols again); `blocked` stays blocked (`webinar.access.blocked`).
 * - Every call (re)sends the access email, at most 3 per registration per rolling hour
 *   (`access_emails_sent`, `last_access_email_at`, under the row lock).
 * - Ticked consent boxes write `consent_records` through `crm.recordConsent` (method `form`,
 *   source `webinar:<slug>`, the wording version shown); registering never grants consent itself
 *   (rule 18). Registration is not attendance (rule 17): only `webinar.registered` is written.
 *
 * The raw token is never stored: the row holds `sha256(token)` and the link is recomputed from
 * the registration id and `token_version` (`webinarAccessUrl`, rule 19). Revoking bumps the
 * version. Nothing here calls a provider: the email is queued through `email.sendTransactional`
 * in the same transaction (the outbox).
 */
import { randomUUID } from "node:crypto";
import { persons, webinarRegistrations, webinars } from "@beam/db/schema";
import { emailHash, normaliseEmail } from "@beam/core/crm";
import { type Locale, type LocalizedText } from "@beam/core/i18n";
import { canRegister, hashAccessToken, registeredModeFor, type RegistrationSource, type Utm, type WatchMode } from "@beam/core/webinar";
import {
  spokenLanguageName,
  titleIn,
  webinarAccessToken,
  webinarAccessUrl,
  webinarDate,
  webinarIcsUrl,
  webinarLandingUrl,
} from "@beam/email/templates/webinar";
import { ConflictError, NotFoundError, ValidationError, and, eq, inArray, type Ctx, type DbOrTx, type Tx } from "@/lib/ctx";
import { rateLimit } from "@/lib/rate-limit";
import { findOrCreatePersonByEmail, findPersonIdsByEmailHash, getCurrentMarketingWordings, getPersonStatus, recordConsent, resolveCanonicalPersonId, resolvePersonIds } from "@/modules/crm/api";
import { sendTransactional } from "@/modules/email/api";
import { endsAtOf, type WebinarRow } from "./lifecycle";

export type RegistrationRow = typeof webinarRegistrations.$inferSelect;
export type ConsentChoice = { events?: boolean; newsletter?: boolean };

export type RegisterPersonInput = {
  webinarId: string;
  personId: string;
  source: RegistrationSource;
  locale: Locale;
  utm: Utm;
  consents?: ConsentChoice;
  wordingVersion?: string;
  /** Staff may register without sending the access email (`registerPersonByStaff`). Default true. */
  sendAccessEmail?: boolean;
};

export type RegisterPersonResult = { registrationId: string; created: boolean };

/** Access emails per registration per rolling hour (rule 14). */
export const ACCESS_EMAILS_PER_HOUR = 3;
const HOUR_MS = 3_600_000;
/** Public registrations and lost-link requests per IP per minute (section 4.4). */
export const PUBLIC_REGISTER_PER_MINUTE = 20;
/**
 * The fallback consent wording version: the form's catalogue text, recorded as `<purpose>@1`.
 * The form shows crm's published wording instead when there is one
 * (`registrationConsentWordings`, webinar-P3 request).
 */
export const WEBINAR_CONSENT_WORDING_VERSION = "v1";

/** What the registration form shows for its two consent boxes (rule 18). */
export type RegistrationConsentWordings = {
  /** `events@<n>,newsletter@<m>`: the version of each text shown, sent back with the form. */
  wordingVersion: string;
  /** crm's published text in the locale; null means the form shows its catalogue label (version 1). */
  events: string | null;
  newsletter: string | null;
};

/**
 * crm's currently published wording of `events` and `newsletter` in `locale`, with the version
 * the form sends back. A purpose without a published wording (or without text in this locale)
 * falls back to the catalogue label recorded as version 1.
 */
export async function registrationConsentWordings(tx: DbOrTx, locale: Locale): Promise<RegistrationConsentWordings> {
  const published = await getCurrentMarketingWordings(tx);
  const pick = (purpose: "events" | "newsletter") => {
    const w = published[purpose];
    const text = w?.text?.[locale]?.trim();
    return w && text ? { text, version: `${purpose}@${w.version}` } : { text: null, version: `${purpose}@1` };
  };
  const events = pick("events");
  const newsletter = pick("newsletter");
  return { wordingVersion: `${events.version},${newsletter.version}`, events: events.text, newsletter: newsletter.text };
}

/** Error messages of the registration paths (the UI maps them to `webinar.register.errors.*`). */
export const REGISTER_ERRORS = { closed: "webinar.register.closed", blocked: "webinar.access.blocked" } as const;

const minuteOf = (d: Date) => d.toISOString().slice(0, 16);

const isWebinarStatusPublic = (s: WebinarRow["status"]) => s === "published" || s === "live" || s === "ended";

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

async function loadWebinar(tx: DbOrTx, webinarId: string): Promise<WebinarRow> {
  const [w] = await tx.select().from(webinars).where(eq(webinars.id, webinarId));
  if (!w) throw new NotFoundError("webinar_not_found");
  return w;
}

async function lockRegistration(tx: Tx, registrationId: string): Promise<RegistrationRow> {
  const [r] = await tx.select().from(webinarRegistrations).where(eq(webinarRegistrations.id, registrationId)).for("update");
  if (!r) throw new NotFoundError("registration_not_found");
  return r;
}

/**
 * `<purpose>@<n>` for a wording version the form showed: `v1` (or `1`) means version 1 of each
 * purpose; `events@2` is used as is for its own purpose, and a comma-separated list
 * (`events@2,newsletter@3`, from `registrationConsentWordings`) gives each purpose its own.
 */
export function consentWordingVersion(purpose: "events" | "newsletter", wordingVersion: string | undefined): string {
  const v = (wordingVersion ?? WEBINAR_CONSENT_WORDING_VERSION).trim();
  for (const part of v.split(",")) {
    const own = /^([a-z_]+)@([1-9][0-9]*)$/.exec(part.trim());
    if (own && own[1] === purpose) return part.trim();
  }
  const n = /^v?([1-9][0-9]*)$/.exec(v);
  if (n) return `${purpose}@${n[1]}`;
  throw new ValidationError("invalid_wording_version", { wordingVersion: "invalid_wording_version" });
}

/** Only the five UTM keys, trimmed, 1-200 characters each. */
function cleanUtm(utm: Utm | undefined): Utm {
  const out: Record<string, string> = {};
  for (const k of ["source", "medium", "campaign", "content", "term"] as const) {
    const v = utm?.[k]?.trim();
    if (v) out[k] = v.slice(0, 200);
  }
  return out;
}

/** The `webinar.registered` data of section 4.1. */
function registeredData(w: WebinarRow, r: RegistrationRow) {
  return {
    webinar_id: w.id,
    slug: w.slug,
    title: w.title,
    webinar_mode: w.mode,
    starts_at: w.startsAt,
    ends_at: endsAtOf(w),
    registration_id: r.id,
    session: w.sessionId ? { id: w.sessionId, kind: "event" as const } : null,
    person_status: r.personStatus,
    source: r.source,
    utm: (r.utm ?? {}) as Record<string, string>,
  };
}

const ref = (r: Pick<RegistrationRow, "id">) => ({ type: "webinar_registration", id: r.id });

// ---------------------------------------------------------------------------------------------
// The access email (rule 14 throttle)
// ---------------------------------------------------------------------------------------------

/** The props of `webinar.access` for one registration in `locale`. */
export function accessEmailData(w: WebinarRow, r: Pick<RegistrationRow, "id" | "tokenVersion">, locale: Locale) {
  const endsAt = endsAtOf(w);
  return {
    title: titleIn(w.title, locale),
    date: webinarDate(w.startsAt, locale),
    language: spokenLanguageName(w.spokenLocale, locale),
    accessUrl: webinarAccessUrl(r.id, r.tokenVersion, locale),
    landingUrl: webinarLandingUrl(w.slug, locale),
    icsUrl: w.startsAt ? webinarIcsUrl(w.slug, locale) : null,
    startsAt: w.startsAt ? w.startsAt.toISOString() : null,
    endsAt: endsAt ? endsAt.toISOString() : null,
    webinarId: w.id,
    registrationId: r.id,
  };
}

/**
 * Queues the access email under the row lock the caller holds, unless 3 were sent in the rolling
 * hour. The key is `webinar_reg:<id>:access:<n>` for the first email and
 * `webinar_reg:<id>:access:<n>:after:<previous send minute>` afterwards: `<n>` is the new
 * `access_emails_sent`, which restarts at 1 once the previous email is more than an hour old, so
 * the previous send time keeps every key unique (DM-5: a minute bucket of a stored time).
 */
export async function sendAccessEmail(tx: Tx, ctx: Ctx, w: WebinarRow, r: RegistrationRow): Promise<{ sent: boolean }> {
  const now = ctx.now;
  const last = r.lastAccessEmailAt;
  const windowOpen = last !== null && now.getTime() - last.getTime() < HOUR_MS;
  const count = windowOpen ? r.accessEmailsSent : 0;
  if (count >= ACCESS_EMAILS_PER_HOUR) return { sent: false };
  const n = count + 1;
  await tx.update(webinarRegistrations).set({ accessEmailsSent: n, lastAccessEmailAt: now, updatedAt: now }).where(eq(webinarRegistrations.id, r.id));
  const key = last ? `webinar_reg:${r.id}:access:${n}:after:${minuteOf(last)}` : `webinar_reg:${r.id}:access:${n}`;
  await sendTransactional(ctx, {
    template: "webinar.access",
    personId: r.personId,
    locale: r.locale,
    data: accessEmailData(w, r, r.locale),
    context: { webinar_id: w.id, registration_id: r.id },
    key,
  });
  r.accessEmailsSent = n;
  r.lastAccessEmailAt = now;
  return { sent: true };
}

// ---------------------------------------------------------------------------------------------
// registerPerson (rule 14)
// ---------------------------------------------------------------------------------------------

async function recordConsents(tx: Tx, ctx: Ctx, w: WebinarRow, r: RegistrationRow, consents: ConsentChoice | undefined, wordingVersion: string | undefined) {
  for (const purpose of ["events", "newsletter"] as const) {
    if (consents?.[purpose] !== true) continue;
    await recordConsent(tx, ctx, {
      personId: r.personId,
      purpose,
      status: "granted",
      method: "form",
      source: `webinar:${w.slug}`,
      wordingVersion: consentWordingVersion(purpose, wordingVersion),
      ...(ctx.ip ? { ip: ctx.ip } : {}),
      ref: ref(r),
    });
  }
}

export async function registerPerson(tx: Tx, ctx: Ctx, input: RegisterPersonInput): Promise<RegisterPersonResult> {
  const w = await loadWebinar(tx, input.webinarId);
  const personId = await resolveCanonicalPersonId(tx, input.personId);
  const now = ctx.now;
  const id = randomUUID();

  // A new row needs the registration to be open; an existing one is handled below.
  const [existing] = await tx
    .select({ id: webinarRegistrations.id })
    .from(webinarRegistrations)
    .where(and(eq(webinarRegistrations.webinarId, w.id), eq(webinarRegistrations.personId, personId)));
  let inserted = false;
  if (!existing) {
    if (!canRegister(w, now).ok) throw new ConflictError(REGISTER_ERRORS.closed);
    const { status } = await getPersonStatus(tx, personId);
    const rows = await tx
      .insert(webinarRegistrations)
      .values({
        id,
        webinarId: w.id,
        personId,
        accessTokenHash: hashAccessToken(webinarAccessToken(id, 1)),
        tokenVersion: 1,
        registeredMode: registeredModeFor(w, now),
        status: "registered",
        source: input.source,
        locale: input.locale,
        personStatus: status,
        utm: cleanUtm(input.utm),
      })
      .onConflictDoNothing({ target: [webinarRegistrations.webinarId, webinarRegistrations.personId] })
      .returning({ id: webinarRegistrations.id });
    inserted = rows.length > 0;
  }

  const [locked] = await tx
    .select()
    .from(webinarRegistrations)
    .where(and(eq(webinarRegistrations.webinarId, w.id), eq(webinarRegistrations.personId, personId)))
    .for("update");
  const r = locked!;

  if (r.status === "blocked") throw new ConflictError(REGISTER_ERRORS.blocked);

  let dedupeKey: string | null = inserted ? `webinar_reg:${r.id}:registered:v${w.version}` : null;
  if (r.status === "cancelled") {
    if (!canRegister(w, now).ok) throw new ConflictError(REGISTER_ERRORS.closed);
    const previous = r.cancelledAt ?? r.updatedAt;
    const registeredMode: WatchMode = registeredModeFor(w, now);
    await tx
      .update(webinarRegistrations)
      .set({ status: "registered", cancelledAt: null, registeredMode, locale: input.locale, updatedAt: now })
      .where(eq(webinarRegistrations.id, r.id));
    Object.assign(r, { status: "registered", cancelledAt: null, registeredMode, locale: input.locale });
    dedupeKey = `webinar_reg:${r.id}:registered:v${w.version}:after:${minuteOf(previous)}`;
  }

  if (dedupeKey) {
    await ctx.recordEvent({ kind: "webinar.registered", personId: r.personId, ref: ref(r), mode: r.registeredMode, data: registeredData(w, r), dedupeKey });
  }
  await recordConsents(tx, ctx, w, r, input.consents, input.wordingVersion);
  if (input.sendAccessEmail !== false) await sendAccessEmail(tx, ctx, w, r);
  return { registrationId: r.id, created: inserted };
}

// ---------------------------------------------------------------------------------------------
// Public registration by email (site form, `/api/public/webinars/[slug]/register`)
// ---------------------------------------------------------------------------------------------

export type PublicRegistrationInput = {
  email: string;
  firstName: string;
  lastName?: string;
  locale: Locale;
  consents?: ConsentChoice;
  wordingVersion?: string;
  utm?: Utm;
  referralCode?: string | null;
};

/** The public webinar of a slug (published, live or ended), or null. */
export async function findPublicWebinarBySlug(tx: DbOrTx, slug: string): Promise<WebinarRow | null> {
  const [w] = await tx.select().from(webinars).where(eq(webinars.slug, slug));
  return w && isWebinarStatusPublic(w.status) ? w : null;
}

/**
 * Finds or creates the person (`acquisition = {source: 'webinar', campaign: <slug>, webinar_id,
 * utm, referral_code?}` for a new person only, crm rule 3) and registers them with source `site`.
 * A blocked registration answers like a success (the route always answers 202).
 */
export async function registerByEmail(tx: Tx, ctx: Ctx, w: WebinarRow, input: PublicRegistrationInput): Promise<{ registrationId: string | null; created: boolean }> {
  if (!canRegister(w, ctx.now).ok) {
    // Still let an existing (cancelled or registered) person through registerPerson's checks.
    const known = await existingRegistrationByEmail(tx, w.id, input.email);
    if (!known) throw new ConflictError(REGISTER_ERRORS.closed);
  }
  const utm = cleanUtm(input.utm);
  const { personId } = await findOrCreatePersonByEmail(tx, ctx, {
    email: input.email,
    firstName: input.firstName,
    ...(input.lastName ? { lastName: input.lastName } : {}),
    locale: input.locale,
    acquisition: {
      source: "webinar",
      campaign: w.slug,
      webinar_id: w.id,
      ...(Object.keys(utm).length ? { utm } : {}),
      ...(input.referralCode ? { referral_code: input.referralCode } : {}),
    },
  });
  try {
    return await registerPerson(tx, ctx, {
      webinarId: w.id,
      personId,
      source: "site",
      locale: input.locale,
      utm,
      ...(input.consents ? { consents: input.consents } : {}),
      ...(input.wordingVersion ? { wordingVersion: input.wordingVersion } : {}),
    });
  } catch (error) {
    if (error instanceof ConflictError && error.message === REGISTER_ERRORS.blocked) return { registrationId: null, created: false };
    throw error;
  }
}

async function existingRegistrationByEmail(tx: DbOrTx, webinarId: string, email: string): Promise<RegistrationRow | null> {
  const normal = normaliseEmail(email);
  if (!normal) return null;
  const ids = await findPersonIdsByEmailHash(tx, emailHash(normal));
  if (!ids.length) return null;
  const all = new Set<string>();
  for (const pid of ids) for (const x of await resolvePersonIds(tx, pid).catch(() => [pid])) all.add(x);
  const [r] = await tx
    .select()
    .from(webinarRegistrations)
    .where(and(eq(webinarRegistrations.webinarId, webinarId), inArray(webinarRegistrations.personId, [...all])));
  return r ?? null;
}

/**
 * The lost-link page (`/[locale]/webinars/[slug]/join`): when a `registered` registration of this
 * address exists, its access email is sent again (throttled). The caller always answers the same
 * way, whether or not anything was sent.
 */
export async function requestAccessLink(tx: Tx, ctx: Ctx, input: { slug: string; email: string }): Promise<{ sent: boolean }> {
  const [w] = await tx.select().from(webinars).where(eq(webinars.slug, input.slug));
  if (!w || !isWebinarStatusPublic(w.status)) return { sent: false };
  const found = await existingRegistrationByEmail(tx, w.id, input.email);
  if (!found || found.status !== "registered") return { sent: false };
  const r = await lockRegistration(tx, found.id);
  return sendAccessEmail(tx, ctx, w, r);
}

/** Counts one public registration or lost-link request of `ip` (20 per minute); throws `rate_limited`. */
export async function limitPublicRegistration(db: DbOrTx, ip: string | null, now: Date = new Date()): Promise<boolean> {
  const verdict = await rateLimit(db, { key: `webinar_register:ip:${ip ?? "unknown"}`, limit: PUBLIC_REGISTER_PER_MINUTE, windowSeconds: 60 }, now);
  return verdict.ok;
}

// ---------------------------------------------------------------------------------------------
// Cancel, resend, revoke (state table of section 2.3)
// ---------------------------------------------------------------------------------------------

/** `registered` -> `cancelled` and `webinar.registration_cancelled`; a cancelled one is left as is. */
export async function cancelRegistration(tx: Tx, ctx: Ctx, registrationId: string, by: "customer" | "staff"): Promise<{ cancelled: boolean }> {
  const r = await lockRegistration(tx, registrationId);
  if (r.status === "cancelled") return { cancelled: false };
  if (r.status === "blocked") throw new ConflictError("registration_blocked");
  const now = ctx.now;
  await tx.update(webinarRegistrations).set({ status: "cancelled", cancelledAt: now, updatedAt: now }).where(eq(webinarRegistrations.id, r.id));
  await ctx.recordEvent({
    kind: "webinar.registration_cancelled",
    personId: r.personId,
    ref: ref(r),
    mode: r.registeredMode,
    data: { webinar_id: r.webinarId, registration_id: r.id, by },
    dedupeKey: `webinar_reg:${r.id}:registration_cancelled:${minuteOf(now)}`,
  });
  if (ctx.actor.kind === "staff") {
    await ctx.audit({ action: "webinar.registration_cancelled", entityType: "webinar_registration", entityId: r.id, personId: r.personId, oldValue: { status: r.status } });
  }
  return { cancelled: true };
}

/** The customer's own registration (or one of a person merged into them); `not_found` otherwise. */
export async function cancelMyRegistration(ctx: Ctx, personId: string, registrationId: string): Promise<{ cancelled: boolean }> {
  const ids = await resolvePersonIds(ctx.tx, personId);
  const [r] = await ctx.tx.select({ personId: webinarRegistrations.personId }).from(webinarRegistrations).where(eq(webinarRegistrations.id, registrationId));
  if (!r || !ids.includes(r.personId)) throw new NotFoundError("registration_not_found");
  return cancelRegistration(ctx.tx, ctx, registrationId, "customer");
}

/** Resends the personal link (throttle of rule 14); only a `registered` registration has one. */
export async function resendAccessLink(ctx: Ctx, registrationId: string): Promise<{ sent: boolean }> {
  const r = await lockRegistration(ctx.tx, registrationId);
  if (r.status !== "registered") throw new ConflictError(`registration_${r.status}`);
  const w = await loadWebinar(ctx.tx, r.webinarId);
  const result = await sendAccessEmail(ctx.tx, ctx, w, r);
  await ctx.audit({ action: "webinar.access_link_resent", entityType: "webinar_registration", entityId: r.id, personId: r.personId, newValue: result });
  return result;
}

/** `token_version + 1`: every earlier link stops working (rule 19). No email is sent. */
export async function revokeAccessLink(ctx: Ctx, registrationId: string): Promise<{ tokenVersion: number }> {
  const r = await lockRegistration(ctx.tx, registrationId);
  const tokenVersion = r.tokenVersion + 1;
  await ctx.tx
    .update(webinarRegistrations)
    .set({ tokenVersion, accessTokenHash: hashAccessToken(webinarAccessToken(r.id, tokenVersion)), updatedAt: ctx.now })
    .where(eq(webinarRegistrations.id, r.id));
  await ctx.audit({ action: "webinar.access_link_revoked", entityType: "webinar_registration", entityId: r.id, personId: r.personId, newValue: { tokenVersion } });
  return { tokenVersion };
}

/** Staff registration (source `admin`, rule 14); the second permission check of section 7. */
export async function registerPersonByStaff(ctx: Ctx, input: { webinarId: string; personId: string; sendAccessEmail: boolean }): Promise<{ registrationId: string }> {
  ctx.require("persons.read");
  const [p] = await ctx.tx.select({ locale: persons.locale }).from(persons).where(eq(persons.id, input.personId));
  if (!p) throw new NotFoundError("person_not_found");
  const result = await registerPerson(ctx.tx, ctx, {
    webinarId: input.webinarId,
    personId: input.personId,
    source: "admin",
    locale: p.locale,
    utm: {},
    sendAccessEmail: input.sendAccessEmail,
  });
  await ctx.audit({ action: "webinar.person_registered", entityType: "webinar_registration", entityId: result.registrationId, personId: input.personId, newValue: { webinarId: input.webinarId, created: result.created } });
  return { registrationId: result.registrationId };
}

/** The absolute personal link of a registration at its current version (api `getAccessUrl`). */
export async function accessUrlOf(db: DbOrTx, registrationId: string, locale: Locale): Promise<string> {
  const [r] = await db.select({ id: webinarRegistrations.id, tokenVersion: webinarRegistrations.tokenVersion }).from(webinarRegistrations).where(eq(webinarRegistrations.id, registrationId));
  if (!r) throw new NotFoundError("registration_not_found");
  return webinarAccessUrl(r.id, r.tokenVersion, locale);
}

/** The title of a webinar in `locale` (LocalizedText fallback to any filled locale). */
export const webinarTitle = (title: LocalizedText, locale: Locale): string => titleIn(title, locale);

