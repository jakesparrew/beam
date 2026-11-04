/**
 * email's GDPR registration (email spec section 9, architecture section 11, ops rule 62).
 * Facade read by `pnpm gen:indexes`; `emailPrivacy` is the same object under the spec's name.
 *
 * - `export`: every message (date, template, kind, purpose, subject, status, opened and clicked
 *   times), its events (type and time), the campaign memberships (campaign name, status) and the
 *   current reachability per purpose. Resend keeps delivery logs for 30 days, which its API
 *   cannot export; the export says so.
 * - `erase` (runs under `beam.allow_rewrite`, after automation, before forms, commerce and crm): unlinks
 *   `campaign_recipients.email_message_id`, soft-bounce retry links and the other modules' links
 *   (see `unlinkMessages`), deletes the person's
 *   `campaign_recipients` and `email_messages` (cascading `email_events`). It enqueues nothing:
 *   the provider-side step (`ResendClient.deleteContact`) is ops' `privacy.erase_external`.
 * - `sweep`: one handler per retention key, each deleting at most 5,000 rows per call. Before a
 *   message is deleted, every nullable link to it is cleared (`unlinkMessages`, also for erase);
 *   a message an `automation_runs` row still references (`on delete restrict`, append-only) is
 *   skipped until automation's own 730-day sweep has removed that run.
 */
import type { Tx } from "@beam/db";
import type { PrivacyRegistration, RetentionPolicySeed } from "@beam/core/privacy";
import { EMAIL_RETENTION_POLICIES } from "@beam/db/seed/email";
import { sql, type DbOrTx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";

const BATCH = 5000;

const count = async (tx: DbOrTx, q: ReturnType<typeof sql>) => rowsOf(await tx.execute(q)).length;
const allowRewrite = (tx: DbOrTx) => tx.execute(sql`set local beam.allow_rewrite = 'on'`);

/** Retention rows (the same list the `defaults` seed inserts); ops seeds them from `GDPR_REGISTRY`. */
export const retention: readonly RetentionPolicySeed[] = EMAIL_RETENTION_POLICIES;

/**
 * Clears every nullable reference to the messages selected by `ids` before they are deleted:
 * email's own (campaign recipients, soft-bounce retries) and the three links other modules keep
 * with `on delete no action` (`form_submissions.result_email_message_id`,
 * `checkouts.recovery_message_id`, `vouchers.email_message_id`). Erasure runs email before forms
 * and commerce (ERASE_ORDER), and those rows outlive email's 730-day retention, so without this
 * both the erase step and the `email.email_messages` sweep fail on the foreign keys. The link is
 * only a pointer to the delivered email; the submission, checkout and voucher stay intact.
 */
async function unlinkMessages(tx: DbOrTx, ids: ReturnType<typeof sql>): Promise<void> {
  await tx.execute(sql`update campaign_recipients set email_message_id = null, updated_at = now() where email_message_id in (${ids})`);
  await tx.execute(sql`update email_messages set retry_of_message_id = null, updated_at = now() where retry_of_message_id in (${ids})`);
  await tx.execute(sql`update form_submissions set result_email_message_id = null, updated_at = now() where result_email_message_id in (${ids})`);
  await tx.execute(sql`update checkouts set recovery_message_id = null, updated_at = now() where recovery_message_id in (${ids})`);
  await tx.execute(sql`update vouchers set email_message_id = null, updated_at = now() where email_message_id in (${ids})`);
}

export const sweep: Record<string, (tx: Tx, cutoff: Date) => Promise<number>> = {
  "email.email_events": async (tx, cutoff) => {
    await allowRewrite(tx);
    return count(tx, sql`delete from email_events where id in (select id from email_events where occurred_at < ${cutoff} limit ${BATCH}) returning id`);
  },
  "email.email_messages": async (tx, cutoff) => {
    await allowRewrite(tx);
    const due = rowsOf<{ id: string }>(
      await tx.execute(sql`
        select m.id from email_messages m left join campaigns c on c.id = m.campaign_id
        where m.created_at < ${cutoff} and (m.campaign_id is null or c.stats_snapshot is not null)
          and not exists (select 1 from automation_runs r where r.email_message_id = m.id)
        order by m.created_at
        limit ${BATCH}`),
    ).map((r) => r.id);
    if (!due.length) return 0;
    const ids = sql`select unnest(${`{${due.join(",")}}`}::uuid[])`;
    await unlinkMessages(tx, ids);
    return count(tx, sql`delete from email_messages where id in (${ids}) returning id`);
  },
  "email.campaign_recipients": (tx, cutoff) =>
    count(
      tx,
      sql`delete from campaign_recipients where id in (
        select r.id from campaign_recipients r join campaigns c on c.id = r.campaign_id
        where c.finished_at is not null and c.finished_at < ${cutoff} limit ${BATCH}) returning id`,
    ),
  "email.email_ai_drafts": async (tx, cutoff) => {
    const old = sql`select id from email_ai_drafts where created_at < ${cutoff} limit ${BATCH}`;
    await tx.execute(sql`update campaigns set ai_draft_id = null where ai_draft_id in (${old})`);
    await tx.execute(sql`update email_template_versions set ai_draft_id = null where ai_draft_id in (${old})`);
    return count(tx, sql`delete from email_ai_drafts where id in (${old}) returning id`);
  },
};

type ExportMessage = {
  id: string;
  created_at: string;
  sent_at: string | null;
  template: string | null;
  kind: string;
  purpose: string | null;
  subject: string | null;
  status: string;
  opened_at: string | null;
  clicked_at: string | null;
};

async function exportPerson(tx: Tx, personId: string): Promise<Record<string, unknown>> {
  const messages = rowsOf<ExportMessage>(
    await tx.execute(sql`
      select m.id, m.created_at, m.sent_at, t.name as template, m.kind, m.purpose, m.subject, m.status, m.opened_at, m.clicked_at
      from email_messages m
      left join email_template_versions v on v.id = m.template_version_id
      left join email_templates t on t.id = v.template_id
      where m.person_id = ${personId}::uuid order by m.created_at desc`),
  );
  const events = rowsOf<{ email_message_id: string; type: string; occurred_at: string }>(
    await tx.execute(sql`
      select e.email_message_id, e.type, e.occurred_at from email_events e join email_messages m on m.id = e.email_message_id
      where m.person_id = ${personId}::uuid order by e.occurred_at`),
  );
  const campaignRecipients = rowsOf<{ campaign: string; status: string }>(
    await tx.execute(sql`
      select c.name as campaign, r.status from campaign_recipients r join campaigns c on c.id = r.campaign_id
      where r.person_id = ${personId}::uuid order by r.created_at`),
  );
  const reach = rowsOf<{ purpose: string; is_reachable: boolean; blocked_reason: string | null }>(
    await tx.execute(sql`select purpose, is_reachable, blocked_reason from v_marketing_reachability where person_id = ${personId}::uuid order by purpose`),
  );
  return {
    messages,
    events,
    campaignRecipients,
    preferences: Object.fromEntries(reach.map((r) => [r.purpose, { reachable: r.is_reachable, blockedReason: r.blocked_reason }])),
    provider: "Resend keeps delivery logs for 30 days; its API offers no export of them.",
  };
}

async function erasePerson(tx: Tx, personId: string) {
  await allowRewrite(tx);
  const ids = sql`select id from email_messages where person_id = ${personId}::uuid`;
  await unlinkMessages(tx, ids);
  const events = rowsOf<{ n: number }>(
    await tx.execute(sql`select count(*)::int as n from email_events where email_message_id in (${ids})`),
  )[0]?.n ?? 0;
  const recipients = await count(tx, sql`delete from campaign_recipients where person_id = ${personId}::uuid returning id`);
  const messages = await count(tx, sql`delete from email_messages where person_id = ${personId}::uuid returning id`);
  return [
    { table: "campaign_recipients", rows: recipients, action: "deleted" },
    { table: "email_messages", rows: messages, action: "deleted" },
    { table: "email_events", rows: Number(events), action: "deleted" },
  ];
}

export const privacy: PrivacyRegistration<Tx> = {
  tables: ["email_messages", "email_events", "campaign_recipients", "email_ai_drafts"],
  export: (tx, personId) => exportPerson(tx, personId),
  erase: (tx, personId) => erasePerson(tx, personId),
  sweep,
  retention,
};

export const emailPrivacy = privacy;

/** Staff user ids only (email spec section 9): nothing to export or erase for a person. */
export const noPiiTables = ["campaigns", "email_templates", "email_template_versions"] as const;
