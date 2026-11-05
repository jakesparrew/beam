/**
 * `findLatestMessage()` (email spec section 4 "Cross-module API", R2, email-P8): the newest
 * message one person received from one template after a cutoff, for commerce's abandoned-checkout
 * recovery attribution (`commerce.checkout_recovery`).
 *
 * The template slug resolves to every version of that template (a template edited and
 * republished between the cutoff and now has several), and the lookup runs on the
 * `(person_id, template_version_id, created_at desc)` index `email_messages_person_template_idx`.
 * "After" is strict: a message created exactly at the cutoff does not count. Test sends
 * (`kind = test`) never count. Any status is returned (a suppressed or failed message is still
 * the latest attempt); the caller decides what to do with `status`, `sentAt` and `clickedAt`.
 * Reads only; never writes.
 */
import type { DbOrTx } from "@beam/db";
import { emailMessages, emailTemplates, emailTemplateVersions } from "@beam/db/schema";
import type { MessageStatus } from "@beam/core/email";
import { and, desc, eq, gt, inArray, ne } from "@/lib/ctx";

export type LatestMessageInput = { personId: string; templateSlug: string; after: Date };
export type LatestMessage = { emailMessageId: string; status: MessageStatus; sentAt: Date | null; clickedAt: Date | null };

/** The ids of every version of the template with `slug` (empty for an unknown slug). */
async function versionIdsOf(db: DbOrTx, slug: string): Promise<string[]> {
  const rows = await db
    .select({ id: emailTemplateVersions.id })
    .from(emailTemplateVersions)
    .innerJoin(emailTemplates, eq(emailTemplates.id, emailTemplateVersions.templateId))
    .where(eq(emailTemplates.slug, slug));
  return rows.map((r) => r.id);
}

/** The message lookup itself (one person, the template's version ids, after the cutoff), on `email_messages_person_template_idx`. */
export function latestMessageQuery(db: DbOrTx, input: { personId: string; versionIds: string[]; after: Date }) {
  return db
    .select({ id: emailMessages.id, status: emailMessages.status, sentAt: emailMessages.sentAt, clickedAt: emailMessages.clickedAt })
    .from(emailMessages)
    .where(
      and(
        eq(emailMessages.personId, input.personId),
        inArray(emailMessages.templateVersionId, input.versionIds),
        gt(emailMessages.createdAt, input.after),
        ne(emailMessages.kind, "test"),
      ),
    )
    .orderBy(desc(emailMessages.createdAt), desc(emailMessages.id))
    .limit(1);
}

export async function findLatestMessage(db: DbOrTx, input: LatestMessageInput): Promise<LatestMessage | null> {
  if (!input.personId || !input.templateSlug) return null;
  const versionIds = await versionIdsOf(db, input.templateSlug);
  if (!versionIds.length) return null;
  const [row] = await latestMessageQuery(db, { personId: input.personId, versionIds, after: input.after });
  if (!row) return null;
  return { emailMessageId: row.id, status: row.status, sentAt: row.sentAt, clickedAt: row.clickedAt };
}
