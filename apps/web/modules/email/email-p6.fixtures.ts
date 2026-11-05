/**
 * Shared fixtures of email-P6's campaign tests (not a test file itself): persons in bulk with
 * `email_hash` and a marketing grant, static crm segments, a published marketing template and a
 * draft campaign on it, and small readers. Bulk rows are inserted in one statement per 500 so the
 * 1,000-recipient cases stay fast on PGlite.
 */
import type { Db } from "@beam/db";
import { makeUser } from "@beam/db/testing";
import { campaignRecipients, campaigns, consentRecords, jobs, persons, segmentMembers, segments } from "@beam/db/schema";
import { emailHash } from "@beam/core/crm";
import type { MarketingPurpose } from "@beam/core/email";
import type { Locale } from "@beam/core/i18n";
import { and, eq, sql } from "@/lib/ctx";
import { blockTemplate } from "./email-p3.fixtures";

let run = 0;

/** `n` persons with a granted consent for `purpose` (unless `consent: false`). */
export async function bulkPersons(
  db: Db,
  n: number,
  opts: { purpose?: MarketingPurpose; locale?: Locale; consent?: boolean; tag?: string } = {},
): Promise<string[]> {
  const tag = `${opts.tag ?? "p6"}-${++run}-${Date.now().toString(36)}`;
  const ids: string[] = [];
  for (let start = 0; start < n; start += 500) {
    const values = Array.from({ length: Math.min(500, n - start) }, (_, j) => {
      const email = `${tag}-${start + j}@example.com`;
      return { email, emailHash: emailHash(email), firstName: `First${start + j}`, lastName: `Last ${tag}`, locale: opts.locale ?? "nl-BE", isTester: true, acquisition: { source: "manual" } };
    });
    const rows = await db.insert(persons).values(values).returning({ id: persons.id });
    ids.push(...rows.map((r) => r.id));
  }
  if (opts.consent !== false) await grant(db, ids, opts.purpose ?? "newsletter");
  return ids;
}

/** Granted (or withdrawn) consent records, written in bulk with the system actor. */
export async function grant(db: Db, personIds: readonly string[], purpose: MarketingPurpose, status: "granted" | "withdrawn" = "granted", recordedAt = new Date()): Promise<void> {
  for (let start = 0; start < personIds.length; start += 500) {
    await db.insert(consentRecords).values(
      personIds.slice(start, start + 500).map((personId) => ({
        personId,
        purpose,
        status,
        source: "test:p6",
        method: "form" as const,
        wordingVersion: `${purpose}@1`,
        recordedAt,
        actor: { kind: "system" as const, id: null },
      })),
    );
  }
}

/** A static crm segment with these members. */
export async function staticSegment(db: Db, name: string, personIds: readonly string[]): Promise<string> {
  const [s] = await db.insert(segments).values({ name, kind: "static" }).returning({ id: segments.id });
  for (let start = 0; start < personIds.length; start += 500) {
    const part = personIds.slice(start, start + 500);
    if (part.length) await db.insert(segmentMembers).values(part.map((personId) => ({ segmentId: s!.id, personId, source: "manual" as const })));
  }
  return s!.id;
}

let tplCounter = 0;

/** A published marketing template (all three locales unless `locales`) and its id. */
export async function publishedTemplate(db: Db, purpose: MarketingPurpose = "newsletter", locales?: readonly Locale[]): Promise<string> {
  return blockTemplate(db, { slug: `p6-tpl-${++tplCounter}-${Date.now().toString(36)}`, kind: "marketing", purpose, ...(locales ? { locales } : {}) });
}

/** A staff user for `created_by_user_id` and audits. */
export async function staff(db: Db, roleKey: "marketing" | "owner" = "marketing") {
  return makeUser(db, { roleKey, email: `p6-${roleKey}-${++run}-${Date.now().toString(36)}@demo.beam.be` });
}

/** A campaign row written directly (state set up for engine tests). */
export async function campaignRow(db: Db, values: Partial<typeof campaigns.$inferInsert> & { templateId: string; createdByUserId: string }) {
  const [row] = await db
    .insert(campaigns)
    .values({ name: `P6 campaign ${++run}`, purpose: "newsletter", ...values })
    .returning();
  return row!;
}

export async function campaignOf(db: Db, id: string) {
  const [c] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  return c!;
}

export async function recipientsOf(db: Db, campaignId: string) {
  return db.select().from(campaignRecipients).where(eq(campaignRecipients.campaignId, campaignId));
}

export async function recipientStatusCounts(db: Db, campaignId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: campaignRecipients.status, n: sql<number>`count(*)::int` })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaignId))
    .groupBy(campaignRecipients.status);
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

export async function jobsWithKeyPrefix(db: Db, prefix: string) {
  return db.select().from(jobs).where(sql`${jobs.idempotencyKey} like ${`${prefix}%`}`);
}

export async function jobOfKey(db: Db, key: string) {
  const [j] = await db.select().from(jobs).where(and(eq(jobs.idempotencyKey, key)));
  return j;
}
