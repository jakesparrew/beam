/**
 * crm views (crm spec 2.9, data model 2.0). Each view is `pgView(name, columns).existing()` with
 * its SQL exported beside it as `<name>Sql`; `pnpm db:views` writes the migration and
 * `createTestDb()` applies the same SQL (DM-1).
 *
 * `v_status_override_conflicts` reads credits' `v_person_status`, which credits-P1 creates in
 * the same wave. Its SQL export (`vStatusOverrideConflictsSql`) is therefore a string only when
 * the schema index declares `vPersonStatusSql`; until then it is `undefined`, which `db:views`
 * and `createTestDb()` skip, so the database builds without credits. The definition itself is
 * always available as `STATUS_OVERRIDE_CONFLICTS_DEFINITION` (crm's tests create it on top of
 * a fixture `v_person_status`).
 */
import {
  boolean,
  jsonb,
  pgView,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { ActorJson } from "./_shared";
import {
  consentRecordsLawfulBasis,
  consentRecordsMethod,
  consentRecordsPurpose,
  consentRecordsStatus,
  personDeclarationsKind,
  personDeclarationsStatus,
  personsStatusOverride,
  tasksKind,
  tasksPriority,
  tasksSource,
  tasksStatus,
} from "./crm";
import * as schemaIndex from "./index";

const tstz = (name: string) => timestamp(name, { withTimezone: true });

// ---------------------------------------------------------------------------
// v_consent_current: latest record per person and purpose (rule 3.13)
// ---------------------------------------------------------------------------

export const vConsentCurrentSql = `select distinct on (person_id, purpose) person_id, purpose, status, lawful_basis, method, source,
       wording_version, recorded_at,
       case when status = 'granted' then recorded_at end as granted_at,
       case when status = 'withdrawn' then recorded_at end as withdrawn_at
from consent_records order by person_id, purpose, recorded_at desc, created_at desc, id desc`;

export const vConsentCurrent = pgView("v_consent_current", {
  personId: uuid("person_id").notNull(),
  purpose: consentRecordsPurpose("purpose").notNull(),
  status: consentRecordsStatus("status").notNull(),
  lawfulBasis: consentRecordsLawfulBasis("lawful_basis").notNull(),
  method: consentRecordsMethod("method").notNull(),
  source: text("source").notNull(),
  wordingVersion: text("wording_version").notNull(),
  recordedAt: tstz("recorded_at").notNull(),
  grantedAt: tstz("granted_at"),
  withdrawnAt: tstz("withdrawn_at"),
}).existing();

// ---------------------------------------------------------------------------
// v_suppression_status: one row per person and marketing purpose (rules 3.19, 3.22)
// ---------------------------------------------------------------------------

export const vSuppressionStatusSql = `select p.id as person_id, pr.purpose,
  (exists (select 1 from suppressions s where s.email_hash = p.email_hash and (
      s.scope = 'all'
      or (s.scope::text = pr.purpose and not (s.reason = 'unsubscribe' and exists (
            select 1 from v_consent_current c where c.person_id = p.id and c.purpose::text = pr.purpose
              and c.status = 'granted' and c.method in ('form','portal','preference_centre')
              and c.recorded_at > s.created_at)))))
    or p.erased_at is not null or p.email is null or p.processing_restricted_at is not null) as is_suppressed
from persons p cross join (values ('newsletter'),('events'),('member_comms'),('b2b')) pr(purpose)
where p.merged_into_person_id is null`;

export const vSuppressionStatus = pgView("v_suppression_status", {
  personId: uuid("person_id").notNull(),
  purpose: text("purpose").$type<"newsletter" | "events" | "member_comms" | "b2b">().notNull(),
  isSuppressed: boolean("is_suppressed").notNull(),
}).existing();

// ---------------------------------------------------------------------------
// v_status_override_conflicts: manual status that no longer matches the derived one (rule 3.11)
// ---------------------------------------------------------------------------

export const STATUS_OVERRIDE_CONFLICTS_DEFINITION = `select p.id as person_id, p.status_override, s.derived_status, p.status_override_at, p.status_override_by_user_id
from persons p join v_person_status s on s.person_id = p.id
where p.status_override is not null and p.status_override::text <> s.derived_status::text
  and p.erased_at is null and p.merged_into_person_id is null`;

/** Only `in` (never a value read) on the namespace, so the import cycle with the index is safe. */
const personStatusDeclared = (): boolean => {
  try {
    return "vPersonStatusSql" in schemaIndex && typeof (schemaIndex as Record<string, unknown>).vPersonStatusSql === "string";
  } catch {
    return false;
  }
};

export const vStatusOverrideConflictsSql: string | undefined = personStatusDeclared()
  ? STATUS_OVERRIDE_CONFLICTS_DEFINITION
  : undefined;

export const vStatusOverrideConflicts = pgView("v_status_override_conflicts", {
  personId: uuid("person_id").notNull(),
  statusOverride: personsStatusOverride("status_override").notNull(),
  derivedStatus: text("derived_status").$type<"lead" | "customer" | "member">().notNull(),
  statusOverrideAt: tstz("status_override_at"),
  statusOverrideByUserId: uuid("status_override_by_user_id"),
}).existing();

// ---------------------------------------------------------------------------
// v_declaration_current: latest declaration per person and kind, with validity (rule 3.54)
// ---------------------------------------------------------------------------

export const vDeclarationCurrentSql = `select distinct on (person_id, kind) person_id, kind, status, document_version_id, accepted_at, expires_at,
       (status = 'accepted' and (expires_at is null or expires_at > now())) as is_valid
from person_declarations order by person_id, kind, accepted_at desc, id desc`;

export const vDeclarationCurrent = pgView("v_declaration_current", {
  personId: uuid("person_id").notNull(),
  kind: personDeclarationsKind("kind").notNull(),
  status: personDeclarationsStatus("status").notNull(),
  documentVersionId: uuid("document_version_id").notNull(),
  acceptedAt: tstz("accepted_at").notNull(),
  expiresAt: tstz("expires_at"),
  isValid: boolean("is_valid").notNull(),
}).existing();

// ---------------------------------------------------------------------------
// v_open_tasks: open tasks with overdue and due-today flags in Brussels time (rule 3.43)
// ---------------------------------------------------------------------------

export const vOpenTasksSql = `select t.*, (t.due_at < now()) as is_overdue,
       (t.due_at >= date_trunc('day', now() at time zone 'Europe/Brussels') at time zone 'Europe/Brussels'
        and t.due_at < (date_trunc('day', now() at time zone 'Europe/Brussels') + interval '1 day') at time zone 'Europe/Brussels') as is_due_today
from tasks t where t.status = 'open'`;

export const vOpenTasks = pgView("v_open_tasks", {
  id: uuid("id").notNull(),
  ownerUserId: uuid("owner_user_id").notNull(),
  personId: uuid("person_id"),
  companyId: uuid("company_id"),
  title: text("title").notNull(),
  kind: tasksKind("kind").notNull(),
  dueAt: tstz("due_at"),
  priority: tasksPriority("priority").notNull(),
  status: tasksStatus("status").notNull(),
  source: tasksSource("source").notNull(),
  refType: text("ref_type"),
  refId: text("ref_id"),
  notes: text("notes"),
  doneAt: tstz("done_at"),
  doneByUserId: uuid("done_by_user_id"),
  createdBy: jsonb("created_by").$type<ActorJson>().notNull(),
  dedupeKey: text("dedupe_key"),
  createdAt: tstz("created_at").notNull(),
  updatedAt: tstz("updated_at").notNull(),
  isOverdue: boolean("is_overdue"),
  isDueToday: boolean("is_due_today"),
}).existing();
