/**
 * Shared fixtures of email-P7's tests (not a test file itself): a published template version to
 * hang messages on, and email messages in bulk (one statement per 500 rows, so the 600 to 2,000
 * row cases of the complaint watch stay fast on PGlite).
 */
import type { Db } from "@beam/db";
import { emailMessages, emailTemplates } from "@beam/db/schema";
import { eq, sql } from "@/lib/ctx";
import { blockTemplate } from "./email-p3.fixtures";

let run = 0;

/** The current version of a fresh published template of `kind`. */
export async function templateVersion(db: Db, kind: "marketing" | "transactional" = "marketing"): Promise<{ templateId: string; versionId: string; slug: string }> {
  const slug = kind === "marketing" ? `p7-tpl-${++run}-${Date.now().toString(36)}` : `email.p7_tpl_${++run}_${Date.now().toString(36)}`;
  const templateId = await blockTemplate(db, { slug, kind, ...(kind === "marketing" ? { purpose: "newsletter" as const } : {}) });
  const [t] = await db.select().from(emailTemplates).where(eq(emailTemplates.id, templateId));
  return { templateId, versionId: t!.currentVersionId!, slug };
}

export type MessageValues = Partial<typeof emailMessages.$inferInsert> & { templateVersionId: string };

/** `n` messages; `each(i)` overrides per row. Defaults: a delivered `news.beam.be` campaign-less marketing message. */
export async function insertMessages(db: Db, n: number, base: MessageValues, each: (i: number) => Partial<typeof emailMessages.$inferInsert> = () => ({})): Promise<string[]> {
  const tag = `p7:${++run}:${Date.now().toString(36)}`;
  const ids: string[] = [];
  for (let start = 0; start < n; start += 500) {
    const values = Array.from({ length: Math.min(500, n - start) }, (_, j) => {
      const i = start + j;
      return {
        kind: "automation" as const,
        purpose: "newsletter" as const,
        locale: "nl-BE",
        fromDomain: "news.beam.be" as const,
        status: "delivered" as const,
        idempotencyKey: `${tag}:${i}`,
        ...base,
        ...each(i),
      };
    });
    const rows = await db.insert(emailMessages).values(values).returning({ id: emailMessages.id });
    ids.push(...rows.map((r) => r.id));
  }
  return ids;
}

/** Deletes every email message and event (and unlinks campaign recipients), like a retention sweep. */
export async function wipeMessages(db: Db, where = sql`true`): Promise<void> {
  await db.execute(sql`set beam.allow_rewrite = 'on'`);
  await db.execute(sql`update campaign_recipients set email_message_id = null where email_message_id in (select id from email_messages where ${where})`);
  await db.execute(sql`delete from email_events where email_message_id in (select id from email_messages where ${where})`);
  await db.execute(sql`delete from email_messages where ${where}`);
  await db.execute(sql`set beam.allow_rewrite = 'off'`);
}
