/**
 * forms's GDPR registration (forms spec section 9, architecture section 11, ops rule 62).
 * Facade read by `pnpm gen:indexes`; `formsPrivacy` is the same object under the spec's name.
 *
 * - `export`: every submission (form name, version, dates, status, answers with labels, score,
 *   outcome, attribution, applied tags, consent snapshot, staff entry yes/no) and the decrypted
 *   sensitive answers through `readSensitive(ctx, personId, 'privacy_export')` (system actor;
 *   writes `sensitive.read` with keys only). Import payloads and links are not exported.
 * - `erase` (under `beam.allow_rewrite`, before crm): deletes the person's submissions,
 *   sensitive answers and import events (by submission or by the sha256 of their email) and nulls
 *   `form_links.referrer_person_id`.
 * - `sweep`: the seven retention handlers of `service/retention.ts`.
 * Merge needs no hook: crm repoints `person_id` columns by `information_schema`.
 */
import { createHash } from "node:crypto";
import type { Tx } from "@beam/db";
import { forms, formSubmissions, formVersions, persons } from "@beam/db/schema";
import { FORMS_RETENTION_POLICIES } from "@beam/db/seed/forms";
import type { PrivacyRegistration, RetentionPolicySeed } from "@beam/core/privacy";
import type { Locale } from "@beam/core/i18n";
import { asc, createCtx, eq, sql, type DbOrTx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { readSubmissionAnswers } from "./service/sensitive";
import { sweep } from "./service/retention";
import { parseVersion } from "./service/versions";

/** The five rows forms seeds (ops seeds `forms.form_submissions` and `forms.form_sensitive_answers`). */
export const retention: readonly RetentionPolicySeed[] = FORMS_RETENTION_POLICIES;

const count = async (tx: DbOrTx, q: ReturnType<typeof sql>): Promise<number> => rowsOf(await tx.execute(q)).length;
const sha256 = (s: string): string => createHash("sha256").update(s.trim().toLowerCase()).digest("hex");

async function exportPerson(tx: Tx, personId: string) {
  const rows = await tx
    .select({ s: formSubmissions, name: forms.name, slug: forms.slug, v: formVersions })
    .from(formSubmissions)
    .innerJoin(forms, eq(forms.id, formSubmissions.formId))
    .innerJoin(formVersions, eq(formVersions.id, formSubmissions.formVersionId))
    .where(eq(formSubmissions.personId, personId))
    .orderBy(asc(formSubmissions.startedAt));
  const ctx = createCtx({ tx, actor: { kind: "system", jobId: "" } });
  const sensitive = rows.length ? await readSubmissionAnswers(ctx, personId, "privacy_export") : [];
  const labels = new Map<string, (key: string) => string>();
  const submissions = rows.map(({ s, name, slug, v }) => {
    const { definition, scoring } = parseVersion(v);
    const locale = s.locale as Locale;
    const label = (key: string): string => {
      if (key.startsWith("score:")) {
        const d = scoring.dimensions.find((x) => x.key === key.slice(6));
        return d?.label[locale] ?? key;
      }
      return definition.fields[key]?.label[locale] ?? key;
    };
    labels.set(s.id, label);
    const outcome = scoring.outcomes.find((o) => o.key === s.outcomeKey);
    return {
      submission_id: s.id,
      form: (name as Record<string, string>)[locale] ?? slug,
      form_slug: slug,
      version: v.version,
      status: s.status,
      locale,
      started_at: s.startedAt.toISOString(),
      completed_at: s.completedAt?.toISOString() ?? null,
      abandoned_at: s.abandonedAt?.toISOString() ?? null,
      answers: Object.entries(s.answers ?? {}).map(([key, value]) => ({ key, label: label(key), value })),
      score: s.score ?? null,
      outcome: s.outcomeKey ? { key: s.outcomeKey, label: outcome?.label[locale] ?? s.outcomeKey } : null,
      source: s.source,
      campaign: s.campaign,
      funnel: s.funnel,
      utm: s.utm ?? {},
      landing_path: s.landingPath,
      applied_tags: s.appliedTagKeys,
      consent_snapshot: s.consentSnapshot ?? [],
      entered_by_staff: s.enteredByUserId !== null,
    };
  });
  return {
    form_submissions: submissions,
    form_sensitive_answers: sensitive.map((a) => ({
      submission_id: a.submissionId,
      key: a.fieldKey,
      label: labels.get(a.submissionId)?.(a.fieldKey) ?? a.fieldKey,
      value: a.value,
    })),
  };
}

async function erasePerson(tx: Tx, personId: string) {
  await tx.execute(sql`set local beam.allow_rewrite = 'on'`);
  const [p] = await tx.select({ email: persons.email }).from(persons).where(eq(persons.id, personId));
  const hash = p?.email ? sha256(p.email) : null;
  const subIds = sql`select id from form_submissions where person_id = ${personId}::uuid`;
  const eventIds = sql`select id from form_import_events where submission_id in (${subIds})${hash ? sql` or email_hash = ${hash}` : sql``}`;
  await tx.execute(sql`update form_submissions set import_event_id = null where import_event_id in (${eventIds})`);
  const imports = await count(tx, sql`delete from form_import_events where id in (${eventIds}) returning id`);
  const sensitive = await count(
    tx,
    sql`delete from form_sensitive_answers where person_id = ${personId}::uuid or submission_id in (${subIds}) returning id`,
  );
  const submissions = await count(tx, sql`delete from form_submissions where person_id = ${personId}::uuid returning id`);
  const links = await count(tx, sql`update form_links set referrer_person_id = null, updated_at = now() where referrer_person_id = ${personId}::uuid returning id`);
  return [
    { table: "form_import_events", rows: imports, action: "deleted" },
    { table: "form_sensitive_answers", rows: sensitive, action: "deleted" },
    { table: "form_submissions", rows: submissions, action: "deleted" },
    { table: "form_links", rows: links, action: "anonymised" },
  ];
}

export const privacy: PrivacyRegistration<Tx> = {
  tables: ["form_submissions", "form_sensitive_answers", "form_links", "form_import_events"],
  export: (tx, personId) => exportPerson(tx, personId),
  erase: (tx, personId) => erasePerson(tx, personId),
  sweep,
  retention,
};

export const formsPrivacy = privacy;

/** Definitions, staff user ids, aggregates and secret hashes only (forms spec section 9). */
export const noPiiTables = ["forms", "form_versions", "form_views_daily", "form_import_sources"];
