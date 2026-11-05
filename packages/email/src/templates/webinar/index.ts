/**
 * webinar's transactional templates (webinar spec section 8). Registry keys and
 * `email_templates.slug` values `webinar.<name>`, where `<name>` is the file basename with `-`
 * replaced by `_`: `webinar.access` (webinar-P3; attaches the `.ics`), `webinar.reminder`
 * (webinar-P3; `loadProps`, variant from the step key), `webinar.rescheduled`,
 * `webinar.cancelled` (webinar-P2) and `webinar.replay_available` (webinar-P3; `loadProps`).
 *
 * The personal links are built here once (`webinarAccessUrl`, rule 19), so the app's direct sends
 * and the automation sends (`loadProps`) produce the same URL. `loadProps` reads the registration
 * through the caller's transaction with one query; `@beam/email` cannot import `@beam/db`
 * (architecture section 1), so it uses the transaction's `execute()` with a plain SQL string
 * whose only inputs are UUIDs validated here.
 */
import { LOCALES, URL_SEGMENT, formatDateTime, isLocale, type Locale } from "@beam/core/i18n";
import { deriveAccessKey, signAccessToken } from "@beam/core/webinar";
import { defineTemplate, type LoadPropsArgs, type TemplateAttachment } from "../define";
import { Access, AccessProps, buildWebinarIcs } from "./access";
import { Cancelled, CancelledProps } from "./cancelled";
import { REMINDER_VARIANTS, Reminder, ReminderProps, type ReminderVariant } from "./reminder";
import { ReplayAvailable, ReplayAvailableProps } from "./replay-available";
import { Rescheduled, RescheduledProps } from "./rescheduled";

export { buildWebinarIcs, type WebinarIcsInput } from "./access";
export { REMINDER_VARIANTS, type ReminderVariant } from "./reminder";

// ---------------------------------------------------------------------------------------------
// Links (rule 19: `/<l>/w/<registration_id>.<token_version>.<mac>`)
// ---------------------------------------------------------------------------------------------

/**
 * The key outside production when `AUTH_SECRET` is unset (tests and local runs); the webinar test
 * factories sign with the same value. Production refuses to build a link without the secret.
 */
export const DEV_WEBINAR_AUTH_SECRET = "webinar-test-auth-secret-0123456789abcdef";

export function webinarAuthSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") throw new Error("AUTH_SECRET is not set");
  return DEV_WEBINAR_AUTH_SECRET;
}

const keys = new Map<string, Uint8Array>();
/** `HKDF-SHA256(AUTH_SECRET, 'beam-webinar-access-v1')`, derived once per secret. */
export function webinarAccessKey(): Uint8Array {
  const secret = webinarAuthSecret();
  let key = keys.get(secret);
  if (!key) {
    key = deriveAccessKey(secret);
    keys.set(secret, key);
  }
  return key;
}

/** `APP_URL` without a trailing slash. */
export function webinarAppOrigin(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

/** The raw access token of a registration at its current `token_version` (never stored). */
export function webinarAccessToken(registrationId: string, tokenVersion: number): string {
  return signAccessToken(webinarAccessKey(), registrationId, tokenVersion);
}

/** The absolute personal link `<APP_URL>/<l>/w/<token>`. */
export function webinarAccessUrl(registrationId: string, tokenVersion: number, locale: Locale): string {
  return `${webinarAppOrigin()}/${URL_SEGMENT[locale]}/w/${webinarAccessToken(registrationId, tokenVersion)}`;
}

/** The absolute landing page `<APP_URL>/<l>/webinars/<slug>`. */
export function webinarLandingUrl(slug: string, locale: Locale): string {
  return `${webinarAppOrigin()}/${URL_SEGMENT[locale]}/webinars/${slug}`;
}

/** The absolute public `.ics` route of a webinar. */
export function webinarIcsUrl(slug: string, locale: Locale): string {
  return `${webinarAppOrigin()}/api/public/webinars/${slug}/ics?locale=${locale}`;
}

/** The spoken language named in `locale` as `Intl.DisplayNames` writes it ("Nederlands", "Dutch", "néerlandais"). */
export function spokenLanguageName(spoken: Locale, locale: Locale): string {
  const code = spoken.slice(0, 2);
  try {
    const name = new Intl.DisplayNames([locale], { type: "language" }).of(code);
    if (name) return name;
  } catch {
    // An engine without DisplayNames falls back to the code.
  }
  return code;
}

/** The start in Brussels time, long form, in `locale`. */
export function webinarDate(startsAt: Date | string | null, locale: Locale): string {
  return startsAt ? formatDateTime(startsAt, locale, "full") : "";
}

// ---------------------------------------------------------------------------------------------
// loadProps: one registration read through the caller's transaction
// ---------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Executor = { execute(query: string): Promise<unknown> };

export type WebinarRegistrationContext = {
  registrationId: string;
  tokenVersion: number;
  webinarId: string;
  slug: string;
  title: Record<string, string>;
  startsAt: string | null;
  spokenLocale: Locale;
  replayUntilAt: string | null;
};

const rowsOf = (result: unknown): Array<Record<string, unknown>> =>
  Array.isArray(result) ? (result as Array<Record<string, unknown>>) : (((result as { rows?: unknown[] } | null)?.rows ?? []) as Array<Record<string, unknown>>);

/**
 * The registration of `context.registration_id` with its webinar, when it belongs to `personId`
 * (or to a person merged into it, or the person `personId` was merged into). Throws otherwise, so
 * email stores no props and the send fails with `invalid_template_data`.
 */
export async function loadWebinarRegistration(tx: unknown, args: Pick<LoadPropsArgs, "personId" | "context">): Promise<WebinarRegistrationContext> {
  const registrationId = args.context.registration_id ?? "";
  const personId = args.personId ?? "";
  if (!UUID.test(registrationId)) throw new Error("webinar template: context.registration_id is missing or not a uuid");
  if (!UUID.test(personId)) throw new Error("webinar template: personId is not a uuid");
  const db = tx as Executor;
  if (typeof db?.execute !== "function") throw new Error("webinar template: loadProps needs a transaction");
  const rows = rowsOf(
    await db.execute(`select r.id::text as registration_id, r.token_version, w.id::text as webinar_id, w.slug, w.title,
        to_json(w.starts_at) #>> '{}' as starts_at, w.spoken_locale::text as spoken_locale,
        to_json(w.replay_until_at) #>> '{}' as replay_until_at
      from webinar_registrations r
      join webinars w on w.id = r.webinar_id
      join persons p on p.id = r.person_id
      where r.id = '${registrationId}'::uuid
        and (r.person_id = '${personId}'::uuid or p.merged_into_person_id = '${personId}'::uuid
             or r.person_id = (select merged_into_person_id from persons where id = '${personId}'::uuid))`),
  );
  const row = rows[0];
  if (!row) throw new Error("webinar template: registration not found for this person");
  const spoken = String(row.spoken_locale);
  return {
    registrationId: String(row.registration_id),
    tokenVersion: Number(row.token_version),
    webinarId: String(row.webinar_id),
    slug: String(row.slug),
    title: (typeof row.title === "string" ? JSON.parse(row.title) : row.title) as Record<string, string>,
    startsAt: row.starts_at ? String(row.starts_at) : null,
    spokenLocale: isLocale(spoken) ? spoken : "nl-BE",
    replayUntilAt: row.replay_until_at ? String(row.replay_until_at) : null,
  };
}

/** The title in `locale`, else any filled locale. */
export function titleIn(title: Record<string, string | undefined>, locale: Locale): string {
  for (const l of [locale, ...LOCALES]) {
    const v = title[l]?.trim();
    if (v) return v;
  }
  return "";
}

/** `d7`, `d3` or `h3` from the journey step key; anything else is refused. */
export function reminderVariant(stepKey: string | null): ReminderVariant {
  const v = (REMINDER_VARIANTS as readonly string[]).find((x) => x === stepKey);
  if (!v) throw new Error(`webinar.reminder: unknown step key "${String(stepKey)}"`);
  return v as ReminderVariant;
}

const SAMPLE_IDS = { webinarId: "00000000-0000-4000-8000-00000000000a", registrationId: "00000000-0000-4000-8000-00000000000b" };

export const templates = [
  defineTemplate({
    name: "access",
    component: Access,
    props: AccessProps,
    sample: {
      title: "Beter slapen",
      date: "dinsdag 12 januari 2027 om 19:00",
      language: "Nederlands",
      accessUrl: "https://beam.example.com/nl/w/sample-token",
      landingUrl: "https://beam.example.com/nl/webinars/beter-slapen",
      icsUrl: "https://beam.example.com/api/public/webinars/beter-slapen/ics?locale=nl-BE",
      startsAt: "2027-01-12T18:00:00.000Z",
      endsAt: "2027-01-12T19:00:00.000Z",
      ...SAMPLE_IDS,
    },
    slots: {
      subject: "webinar.email.access.subject",
      preheader: "webinar.email.access.preheader",
      heading: "webinar.email.access.heading",
      intro: "webinar.email.access.intro",
      intro_on_demand: "webinar.email.access.intro_on_demand",
      language: "webinar.email.access.language",
      cta: "webinar.email.access.cta",
      personal: "webinar.email.access.personal",
      calendar: "webinar.email.access.calendar",
    },
    attachments(props: AccessProps): Promise<TemplateAttachment[]> {
      if (!props.startsAt || !props.endsAt) return Promise.resolve([]);
      const ics = buildWebinarIcs({ webinarId: props.webinarId, title: props.title, startsAt: props.startsAt, endsAt: props.endsAt, url: props.landingUrl });
      return Promise.resolve([{ filename: "webinar.ics", content: new TextEncoder().encode(ics), contentType: "text/calendar; charset=utf-8; method=PUBLISH" }]);
    },
  }),
  defineTemplate({
    name: "reminder",
    component: Reminder,
    props: ReminderProps,
    sample: {
      variant: "d3",
      title: "Beter slapen",
      date: "dinsdag 12 januari 2027 om 19:00",
      language: "Nederlands",
      accessUrl: "https://beam.example.com/nl/w/sample-token",
      ...SAMPLE_IDS,
    },
    slots: {
      subject: "webinar.email.reminder.subject",
      heading: "webinar.email.reminder.heading",
      intro: "webinar.email.reminder.intro",
      language: "webinar.email.reminder.language",
      cta: "webinar.email.reminder.cta",
      personal: "webinar.email.reminder.personal",
    },
    async loadProps(tx: unknown, args: LoadPropsArgs): Promise<ReminderProps> {
      const variant = reminderVariant(args.stepKey);
      const r = await loadWebinarRegistration(tx, args);
      if (!r.startsAt) throw new Error("webinar.reminder: an on-demand webinar has no reminders");
      return {
        variant,
        title: titleIn(r.title, args.locale),
        date: webinarDate(r.startsAt, args.locale),
        language: spokenLanguageName(r.spokenLocale, args.locale),
        accessUrl: webinarAccessUrl(r.registrationId, r.tokenVersion, args.locale),
        webinarId: r.webinarId,
        registrationId: r.registrationId,
      };
    },
  }),
  defineTemplate({
    name: "rescheduled",
    component: Rescheduled,
    props: RescheduledProps,
    sample: {
      title: "Beter slapen",
      date: "donderdag 14 januari 2027 om 19:00",
      oldDate: "dinsdag 12 januari 2027 om 19:00",
      url: "https://beam.example.com/nl/webinars/beter-slapen",
    },
    slots: {
      subject: "webinar.email.rescheduled.subject",
      heading: "webinar.email.rescheduled.heading",
      intro: "webinar.email.rescheduled.intro",
      link_valid: "webinar.email.rescheduled.link_valid",
      cta: "webinar.email.rescheduled.cta",
    },
  }),
  defineTemplate({
    name: "cancelled",
    component: Cancelled,
    props: CancelledProps,
    sample: {
      title: "Beter slapen",
      date: "dinsdag 12 januari 2027 om 19:00",
      url: "https://beam.example.com/nl/webinars/beter-slapen",
    },
    slots: {
      subject: "webinar.email.cancelled.subject",
      heading: "webinar.email.cancelled.heading",
      intro: "webinar.email.cancelled.intro",
      apology: "webinar.email.cancelled.apology",
      cta: "webinar.email.cancelled.cta",
    },
  }),
  defineTemplate({
    name: "replay_available",
    component: ReplayAvailable,
    props: ReplayAvailableProps,
    sample: {
      title: "Beter slapen",
      accessUrl: "https://beam.example.com/nl/w/sample-token",
      until: "zondag 31 januari 2027 om 23:59",
      ...SAMPLE_IDS,
    },
    slots: {
      subject: "webinar.email.replay_available.subject",
      heading: "webinar.email.replay_available.heading",
      intro: "webinar.email.replay_available.intro",
      until: "webinar.email.replay_available.until",
      cta: "webinar.email.replay_available.cta",
      personal: "webinar.email.replay_available.personal",
    },
    async loadProps(tx: unknown, args: LoadPropsArgs): Promise<ReplayAvailableProps> {
      const r = await loadWebinarRegistration(tx, args);
      return {
        title: titleIn(r.title, args.locale),
        accessUrl: webinarAccessUrl(r.registrationId, r.tokenVersion, args.locale),
        until: r.replayUntilAt ? webinarDate(r.replayUntilAt, args.locale) : "",
        webinarId: r.webinarId,
        registrationId: r.registrationId,
      };
    },
  }),
];
