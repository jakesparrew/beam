/**
 * Shared fixtures of email-P3's tests (not a test file itself): complete company settings, persons
 * with `email_hash`, consents through crm's real `recordConsent`, block-backed templates through
 * `seedTemplate`, and small readers.
 */
import type { Db } from "@beam/db";
import { makePerson } from "@beam/db/testing";
import { activityEvents, emailEvents, emailMessages, jobs, persons, settings } from "@beam/db/schema";
import { emailHash } from "@beam/core/crm";
import type { BlockDocument, MarketingPurpose } from "@beam/core/email";
import type { Locale } from "@beam/core/i18n";
import { eq, sql, type Tx } from "@/lib/ctx";
import { makeCtx } from "@/lib/testing";
import { recordConsent } from "@/modules/crm/api";
import { seedTemplate } from "./api";

export const COMPANY = {
  legal_name: "Vibrant Lifestyle Collective BV",
  trade_name: "BEAM Vitality Center",
  vat_number: "BE0123456789",
  enterprise_number: "0123.456.789",
  address: { street: "Voorbeeldstraat 1", postal_code: "9000", city: "Gent", country: "BE" },
  support_email: "support@demo.beam.be",
  phone: "",
  website: "",
};

/** Writes a complete `settings.company`, so the legal footer can be built. */
export async function completeCompany(db: Db): Promise<void> {
  await db.insert(settings).values({ key: "company", value: COMPANY }).onConflictDoUpdate({ target: settings.key, set: { value: COMPANY } });
}

export async function personWith(db: Db, overrides: Partial<typeof persons.$inferInsert> = {}) {
  const p = await makePerson(db, overrides);
  if (p.email) await db.update(persons).set({ emailHash: emailHash(p.email) }).where(eq(persons.id, p.id));
  return { ...p, emailHash: p.email ? emailHash(p.email) : null };
}

/** A marketing grant (or withdrawal) through crm's `recordConsent`. */
export async function consent(
  db: Db,
  personId: string,
  purpose: MarketingPurpose,
  status: "granted" | "withdrawn" = "granted",
  method: "form" | "portal" | "preference_centre" | "import" = "form",
  recordedAt?: Date,
) {
  const ctx = makeCtx(db);
  return recordConsent(db as unknown as Tx, ctx, {
    personId,
    purpose,
    status,
    method,
    source: `test:${method}`,
    wordingVersion: `${purpose}@1`,
    ...(recordedAt ? { recordedAt } : {}),
  });
}

let blockCounter = 0;
const blockId = () => `blk${String(++blockCounter).padStart(7, "0")}`;

/** A small document in `locales` with a heading, a token and one link. */
export function documentIn(locales: readonly Locale[], href = "https://beam.be/en/events"): BlockDocument {
  const doc: BlockDocument = { schemaVersion: 1, locales: {} };
  for (const l of locales) {
    (doc.locales as Record<string, unknown>)[l] = [
      { id: blockId(), type: "heading", level: 1, text: "Hello {{first_name|friend}}" },
      { id: blockId(), type: "text", markdown: `Read [the programme](${href}) for ${l}.` },
    ];
  }
  return doc;
}

const textIn = (locales: readonly Locale[], text: string) => Object.fromEntries(locales.map((l) => [l, `${text} ${l}`]));

export async function blockTemplate(
  db: Db,
  input: { slug: string; kind: "marketing" | "transactional"; purpose?: MarketingPurpose | null; locales?: readonly Locale[] },
): Promise<string> {
  const locales = input.locales ?? (["nl-BE", "fr-BE", "en"] as const);
  const { templateId } = await seedTemplate(db as unknown as Tx, {
    slug: input.slug,
    name: input.slug,
    kind: input.kind,
    purpose: input.kind === "marketing" ? (input.purpose ?? "newsletter") : null,
    subject: textIn(locales, "Subject"),
    preheader: textIn(locales, "Preheader"),
    document: documentIn(locales),
  });
  return templateId;
}

export async function messageOf(db: Db, id: string) {
  const [m] = await db.select().from(emailMessages).where(eq(emailMessages.id, id));
  return m!;
}

export async function eventsOf(db: Db, messageId: string) {
  return db.select().from(emailEvents).where(eq(emailEvents.emailMessageId, messageId));
}

export async function timeline(db: Db, personId: string, kind?: string) {
  const rows = await db.select().from(activityEvents).where(eq(activityEvents.personId, personId));
  return kind ? rows.filter((r) => r.kind === kind) : rows;
}

export async function jobsOf(db: Db, kind: string) {
  return db.select().from(jobs).where(eq(jobs.kind, kind as never));
}

export async function sendJobOf(db: Db, emailMessageId: string) {
  const [job] = await db.select().from(jobs).where(eq(jobs.idempotencyKey, `email:${emailMessageId}`));
  return job;
}

export async function resetEmailTables(db: Db): Promise<void> {
  await db.execute(sql`set beam.allow_rewrite = 'on'`);
  await db.execute(sql`update campaign_recipients set email_message_id = null`);
  await db.execute(sql`delete from email_events`);
  await db.execute(sql`delete from email_messages`);
  await db.execute(sql`delete from jobs`);
  await db.execute(sql`set beam.allow_rewrite = 'off'`);
}
