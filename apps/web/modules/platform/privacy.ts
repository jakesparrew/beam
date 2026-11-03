/**
 * Platform's GDPR registration (platform spec section 9). Facade read by `pnpm gen:indexes`;
 * ops runs export, erase and the retention sweeps. Erase keeps the audit trail provable:
 * values become digests, `person_id` stays.
 */
import type { Tx } from "@beam/db";
import type { EraseReportRow, PrivacyRegistration, RetentionPolicySeed } from "@beam/core/privacy";
import { auditDigest } from "@/lib/audit";
import { sql, type DbOrTx } from "@/lib/ctx";
import { pruneJobs } from "@/lib/job-runner";
import { rowsOf } from "@/lib/sensitive";

const allowRewrite = (tx: DbOrTx) => tx.execute(sql`set local beam.allow_rewrite = 'on'`);
const affected = async (tx: DbOrTx, q: ReturnType<typeof sql>) => rowsOf(await tx.execute(q)).length;

async function exportPerson(tx: Tx, personId: string): Promise<Record<string, unknown>> {
  const users = rowsOf(
    await tx.execute(sql`
      select email, locale::text as locale, created_at, last_login_at, (password_hash is not null) as has_password
      from users where person_id = ${personId} and audience = 'customer'`),
  );
  const audit = rowsOf(await tx.execute(sql`select action, created_at, entity_type from audit_log where person_id = ${personId} order by created_at`));
  const files = rowsOf<{ kind: string; name: string; created_at: unknown; bytes: string | null }>(
    await tx.execute(sql`
      select kind::text as kind, name, created_at,
        case when kind in ('invoice_pdf', 'receipt') then encode(bytes, 'base64') end as bytes
      from files where person_id = ${personId} order by created_at`),
  );
  const ai = rowsOf(await tx.execute(sql`select feature, created_at, fields_sent, prompt, output from ai_requests where person_id = ${personId} order by created_at`));
  return { users, audit_log: audit, files, ai_requests: ai };
}

async function erasePerson(tx: Tx, personId: string): Promise<EraseReportRow[]> {
  await allowRewrite(tx);
  const report: EraseReportRow[] = [];
  const person = rowsOf<{ email: string | null }>(await tx.execute(sql`select lower(email) as email from persons where id = ${personId}`))[0];
  const accountEmails = rowsOf<{ email: string }>(
    await tx.execute(sql`select lower(email) as email from users where person_id = ${personId}`),
  ).map((r) => r.email);

  // Customer and partner accounts of the person; sessions and accounts cascade.
  let tokens = 0;
  for (const email of accountEmails) {
    tokens += await affected(tx, sql`delete from auth_verification_tokens where identifier = ${email} returning identifier`);
  }
  const userIds = rowsOf<{ id: string }>(await tx.execute(sql`select id::text as id from users where person_id = ${personId}`)).map((r) => r.id);
  const sessions = userIds.length
    ? await affected(tx, sql`delete from auth_sessions where user_id::text in (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)}) returning id`)
    : 0;
  const users = await affected(tx, sql`delete from users where person_id = ${personId} returning id`);
  report.push({ table: "users", rows: users, action: "deleted" });
  report.push({ table: "auth_sessions", rows: sessions, action: "deleted" });
  report.push({ table: "auth_verification_tokens", rows: tokens, action: "deleted" });

  // Audit values become digests; ip nulled; person_id kept so the erasure stays provable.
  const audits = rowsOf<{ id: string; old_value: unknown; new_value: unknown }>(
    await tx.execute(sql`select id::text as id, old_value, new_value from audit_log where person_id = ${personId} and not is_redacted`),
  );
  for (const a of audits) {
    await tx.execute(sql`
      update audit_log set
        old_value = ${a.old_value === null ? null : JSON.stringify(auditDigest(a.old_value))}::jsonb,
        new_value = ${a.new_value === null ? null : JSON.stringify(auditDigest(a.new_value))}::jsonb,
        ip = null, is_redacted = true
      where id::text = ${a.id}`);
  }
  report.push({ table: "audit_log", rows: audits.length, action: "redacted" });

  const deletedFiles = await affected(
    tx,
    sql`delete from files where person_id = ${personId} and kind in ('export', 'import', 'rendered_email', 'image') returning id`,
  );
  const keptFiles = await affected(tx, sql`update files set person_id = null where person_id = ${personId} and kind in ('invoice_pdf', 'receipt') returning id`);
  report.push({ table: "files", rows: deletedFiles, action: "deleted" });
  report.push({ table: "files", rows: keptFiles, action: "unlinked" });

  report.push({ table: "ai_requests", rows: await affected(tx, sql`delete from ai_requests where person_id = ${personId} returning id`), action: "deleted" });

  let flags = await affected(
    tx,
    sql`update feature_flags set person_ids = array_remove(person_ids, ${personId}::uuid) where ${personId}::uuid = any(person_ids) returning id`,
  );
  for (const userId of userIds) {
    flags += await affected(tx, sql`update feature_flags set user_ids = array_remove(user_ids, ${userId}::uuid) where ${userId}::uuid = any(user_ids) returning id`);
  }
  report.push({ table: "feature_flags", rows: flags, action: "unlinked" });

  const emails = [...new Set([...(person?.email ? [person.email] : []), ...accountEmails])];
  let hooks = 0;
  for (const email of emails) {
    hooks += await affected(tx, sql`delete from webhook_events where lower(payload::text) like ${`%${email.replace(/[%_\\]/g, (c) => `\\${c}`)}%`} returning id`);
  }
  report.push({ table: "webhook_events", rows: hooks, action: "deleted" });
  return report;
}

const sweepDelete = (q: (cutoff: string) => ReturnType<typeof sql>) => async (tx: Tx, cutoff: Date) => {
  await allowRewrite(tx);
  return affected(tx, q(cutoff.toISOString()));
};

export const retention: readonly RetentionPolicySeed[] = [
  { key: "platform.audit_log", tableName: "audit_log", days: 1826, action: "delete", description: "Audit log rows after 5 years" },
  { key: "platform.ai_requests", tableName: "ai_requests", days: 30, action: "delete", description: "AI request log after 30 days" },
  { key: "platform.webhook_events", tableName: "webhook_events", days: 90, action: "delete", description: "Webhook inbox after 90 days" },
  { key: "platform.integration_calls", tableName: "integration_calls", days: 90, action: "delete", description: "Integration call log after 90 days" },
  { key: "platform.files_export", tableName: "files", days: 7, action: "delete", description: "Export files after 7 days" },
  { key: "platform.files_rendered_email", tableName: "files", days: 30, action: "delete", description: "Rendered email copies after 30 days" },
  { key: "platform.jobs", tableName: "jobs", days: 90, action: "delete", description: "Jobs: succeeded after 7 days, dead after 90 (jobs.prune)" },
  { key: "platform.support_requests", tableName: "support_requests", days: 1095, action: "delete", description: "Closed support requests after 3 years" },
];

export const privacy: PrivacyRegistration<Tx> = {
  tables: ["users", "audit_log", "files", "ai_requests", "feature_flags"],
  export: exportPerson,
  erase: erasePerson,
  sweep: {
    "platform.audit_log": sweepDelete((c) => sql`delete from audit_log where created_at < ${c}::timestamptz returning id`),
    "platform.ai_requests": sweepDelete((c) => sql`delete from ai_requests where created_at < ${c}::timestamptz returning id`),
    "platform.webhook_events": sweepDelete((c) => sql`delete from webhook_events where received_at < ${c}::timestamptz returning id`),
    "platform.integration_calls": sweepDelete((c) => sql`delete from integration_calls where created_at < ${c}::timestamptz returning id`),
    "platform.files_export": sweepDelete((c) => sql`delete from files where kind = 'export' and created_at < ${c}::timestamptz returning id`),
    "platform.files_rendered_email": sweepDelete((c) => sql`delete from files where kind = 'rendered_email' and created_at < ${c}::timestamptz returning id`),
    "platform.jobs": (tx) => pruneJobs(tx),
    "platform.support_requests": sweepDelete((c) => sql`delete from support_requests where status = 'closed' and updated_at < ${c}::timestamptz returning id`),
  },
  retention,
};

export const noPiiTables = [
  "roles",
  "jobs",
  "settings",
  "rate_limits",
  "security_incidents",
  "webhook_events",
  "integration_calls",
  "support_requests",
  "monthly_reports",
];
