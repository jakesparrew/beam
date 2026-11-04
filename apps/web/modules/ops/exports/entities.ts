/**
 * Export column lists and row readers (ops rules 54-56, ops-P6).
 *
 * - Entity exports (`EXPORT_ENTITIES`) use the fixed column lists of `ENTITY_EXPORTS`. None of
 *   them holds a `SENSITIVE_COLUMNS` member, a password, TOTP or recovery secret, a token hash or
 *   a `raw` provider payload (`entities.test.ts` checks every list against the database), and
 *   rows of restricted persons (`persons.processing_restricted_at`) are left out.
 * - The full export covers every base table of the `public` schema: the entity tables with their
 *   fixed lists, every other table with all its columns minus `isExcludedColumn`. Restricted
 *   persons stay in, and `persons` carries the extra column `is_processing_restricted`.
 *
 * Identifiers in the generated SQL come only from these constant lists and from
 * `information_schema` (checked against `SAFE_IDENT`); filter values are bound parameters.
 */
import type { DbOrTx } from "@beam/db";
import { SENSITIVE_COLUMNS } from "@beam/db/schema";
import { EXPORT_ENTITIES, EXPORT_EXCLUDED_COLUMNS, type ExportEntity } from "@beam/core/ops";
import { sql, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";

/** How a table's rows link to a person (for the restricted-person rule and the segment filter). */
export type EntityExport = {
  table: string;
  columns: readonly string[];
  /** SQL expression over alias `t` giving the row's person id; absent when the table has none. */
  person?: string;
  /** Column the `from`/`to` filters apply to. */
  dateColumn: string;
};

const PERSON = "t.person_id";
const VIA_ORDER = "(select o.person_id from orders o where o.id = t.order_id)";

/** Rule 54: the fixed column list of each entity. */
export const ENTITY_EXPORTS: Readonly<Record<ExportEntity, EntityExport>> = {
  persons: {
    table: "persons",
    person: "t.id",
    dateColumn: "created_at",
    columns: [
      "id", "customer_number", "email", "phone", "phone_e164", "first_name", "last_name", "locale", "address", "birth_on",
      "preferred_channel", "linkedin_url", "emergency_contact", "status_override", "status_override_reason", "status_override_at",
      "acquisition", "partner_company_id", "external_ids", "is_tester", "merged_into_person_id", "erased_at", "created_at", "updated_at",
    ],
  },
  companies: {
    table: "companies",
    dateColumn: "created_at",
    columns: ["id", "name", "vat_number", "address", "website", "industry", "size", "status", "owner_user_id", "notes", "is_partner", "partner_commission_pct", "created_at", "updated_at"],
  },
  company_contacts: {
    table: "company_contacts",
    person: PERSON,
    dateColumn: "created_at",
    columns: ["id", "company_id", "person_id", "position", "decision_role", "relationship", "is_primary", "ended_on", "created_at", "updated_at"],
  },
  tags: { table: "tags", dateColumn: "created_at", columns: ["id", "key", "name", "color", "description", "is_system", "created_at", "updated_at"] },
  consents: {
    table: "consent_records",
    person: PERSON,
    dateColumn: "recorded_at",
    columns: ["id", "person_id", "purpose", "status", "lawful_basis", "source", "method", "wording_version", "recorded_at", "ref_type", "ref_id", "created_at"],
  },
  suppressions: { table: "suppressions", person: PERSON, dateColumn: "created_at", columns: ["id", "email_hash", "email", "scope", "reason", "source", "person_id", "created_at"] },
  bookings: {
    table: "bookings",
    person: PERSON,
    dateColumn: "created_at",
    columns: [
      "id", "session_id", "person_id", "status", "paid_with", "guest_of_booking_id", "capacity_units", "order_line_id", "ticket_type_id",
      "is_over_capacity", "is_pay_at_desk", "booked_by_user_id", "source", "external_ref", "rescheduled_from_booking_id",
      "cancelled_at", "cancel_reason_code", "cancel_reason", "attended_at", "no_show_marked_at", "notes", "created_at", "updated_at",
    ],
  },
  sessions: {
    table: "sessions",
    dateColumn: "starts_at",
    columns: [
      "id", "template_id", "kind", "title", "starts_at", "ends_at", "capacity_seats", "capacity_beds", "credit_kind", "credit_cost", "product_id",
      "status", "event_category", "partner_company_id", "is_member_only", "is_lead_magnet", "webinar_id", "location", "cancelled_at", "cancel_reason", "created_at", "updated_at",
    ],
  },
  orders: {
    table: "orders",
    person: PERSON,
    dateColumn: "created_at",
    columns: [
      "id", "reference", "person_id", "company_id", "channel", "status", "subtotal_cents", "discount_cents", "vat_cents", "total_cents", "promotion_id",
      "locale", "renewal_membership_id", "terms_version_id", "withdrawal_until_at", "created_by_user_id", "note", "paid_at", "cancelled_at", "created_at", "updated_at",
    ],
  },
  order_lines: {
    table: "order_lines",
    person: VIA_ORDER,
    dateColumn: "created_at",
    columns: [
      "id", "order_id", "line_no", "product_id", "product_kind", "sku", "price_version_id", "description", "quantity", "unit_amount_cents", "discount_cents",
      "line_total_cents", "vat_rate_pct", "vat_cents", "promotion_id", "session_id", "ticket_type_id", "created_at",
    ],
  },
  payments: {
    table: "payments",
    person: VIA_ORDER,
    dateColumn: "created_at",
    columns: [
      "id", "order_id", "provider", "provider_payment_id", "method", "sequence_type", "status", "amount_cents", "refunded_cents", "chargeback_cents",
      "mandate_id", "cash_received_cents", "failed_reason", "created_by_user_id", "paid_at", "created_at", "updated_at",
    ],
  },
  refunds: {
    table: "refunds",
    person: VIA_ORDER,
    dateColumn: "created_at",
    columns: ["id", "payment_id", "order_id", "amount_cents", "reason", "credit_action", "provider_refund_id", "status", "credit_note_id", "failed_reason", "created_by_user_id", "created_at", "updated_at"],
  },
  invoices: {
    table: "invoices",
    person: PERSON,
    dateColumn: "created_at",
    columns: [
      "id", "kind", "number", "reverses_invoice_id", "order_id", "person_id", "company_id", "customer_snapshot", "lines", "subtotal_cents", "vat_cents", "total_cents",
      "vat_breakdown", "issued_on", "due_on", "status", "billit_status", "fiscal_year", "sequence_number", "is_company", "locale", "currency",
      "issued_at", "paid_at", "settled_via", "payment_method", "payment_reference", "reason", "created_at", "updated_at",
    ],
  },
  credit_grants: {
    table: "credit_grants",
    person: PERSON,
    dateColumn: "created_at",
    columns: [
      "id", "person_id", "product_id", "order_line_id", "voucher_id", "membership_id", "credit_kind", "units_granted", "unit_value_cents", "vat_rate_pct",
      "vat_treatment", "starts_at", "expires_at", "validity_rule", "status", "status_changed_at", "source", "sharing", "label", "note", "created_at", "updated_at",
    ],
  },
  credit_entries: {
    table: "credit_entries",
    person: PERSON,
    dateColumn: "created_at",
    columns: ["id", "grant_id", "person_id", "beneficiary_person_id", "kind", "quantity", "reason", "ref_type", "ref_id", "reverses_entry_id", "created_at"],
  },
  memberships: {
    table: "memberships",
    person: PERSON,
    dateColumn: "created_at",
    columns: [
      "id", "person_id", "product_id", "status", "interval", "source", "started_at", "current_period_start_at", "current_period_end_at", "cancel_at",
      "cancel_requested_at", "ended_at", "end_reason", "mandate_id", "discount_pct", "next_charge_at", "past_due_since_at", "created_at", "updated_at",
    ],
  },
  form_submissions: {
    table: "form_submissions",
    person: PERSON,
    dateColumn: "created_at",
    columns: [
      "id", "form_id", "form_version_id", "person_id", "status", "identified_by", "answers", "score", "outcome_key", "ending_key", "utm", "source",
      "campaign", "funnel", "landing_path", "locale", "external_ref", "started_at", "last_activity_at", "completed_at", "abandoned_at", "created_at",
    ],
  },
  email_messages: {
    table: "email_messages",
    person: PERSON,
    dateColumn: "created_at",
    columns: [
      "id", "person_id", "to_email", "kind", "purpose", "template_version_id", "campaign_id", "enrolment_id", "locale", "subject", "status", "bounce_type",
      "error", "queued_at", "sent_at", "delivered_at", "opened_at", "clicked_at", "bounced_at", "complained_at", "created_at",
    ],
  },
  campaigns: {
    table: "campaigns",
    dateColumn: "created_at",
    columns: [
      "id", "name", "template_id", "segment_id", "purpose", "status", "scheduled_at", "recipients_count", "sent_count", "started_at", "finished_at",
      "stopped_at", "cancelled_at", "created_by_user_id", "created_at", "updated_at",
    ],
  },
  tasks: {
    table: "tasks",
    person: PERSON,
    dateColumn: "created_at",
    columns: ["id", "owner_user_id", "person_id", "company_id", "title", "kind", "due_at", "priority", "status", "source", "ref_type", "ref_id", "notes", "done_at", "done_by_user_id", "created_at", "updated_at"],
  },
  activity_events: {
    table: "activity_events",
    person: PERSON,
    dateColumn: "occurred_at",
    columns: ["id", "person_id", "company_id", "kind", "occurred_at", "mode", "is_sensitive", "ref_type", "ref_id", "created_at"],
  },
};

/** Entity whose table is `table` (the full export uses the fixed lists for them). */
export function entityOfTable(table: string): ExportEntity | null {
  return EXPORT_ENTITIES.find((e) => ENTITY_EXPORTS[e].table === table) ?? null;
}

const EXCLUDED_NAMES = new Set<string>([...EXPORT_EXCLUDED_COLUMNS, "payload", "code_hash", "search_tsv"]);
const EXCLUDED_TYPES = new Set(["bytea", "tsvector"]);

/**
 * Rule 54 for any column: sensitive columns, secrets (password, TOTP, recovery codes,
 * `*_enc`), tokens and token hashes, raw provider payloads, binary and search columns.
 */
export function isExcludedColumn(table: string, column: string, dataType?: string): boolean {
  if (SENSITIVE_COLUMNS.some((c) => c.table === table && c.column === column)) return true;
  if (EXCLUDED_NAMES.has(column)) return true;
  if (dataType && EXCLUDED_TYPES.has(dataType)) return true;
  if (/(^|_)(token|password|secret)(_|$)/.test(column)) return true;
  if (/_enc$/.test(column) || /^recovery_codes/.test(column)) return true;
  return false;
}

const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (name: string): string => {
  if (!SAFE_IDENT.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
};

export type ExportFilters = { from?: string; to?: string; segmentId?: string };

/** The unique order key of a source: column names over alias `t` and their Postgres types. */
export type ExportKey = { columns: string[]; types: string[] };

/** One readable source of rows: its columns, the projection and the stable order. */
export type ExportSource = {
  /** Name of the CSV parts and of the README row (entity name, or table name in a full export). */
  name: string;
  table: string;
  columns: string[];
  excluded: string[];
  select: SQL;
  where: SQL;
  orderBy: SQL;
  /**
   * The primary key the chunks page by (keyset, review findings 2 and 4): chunk n+1 reads the rows
   * after the last key of chunk n, so rows inserted or deleted between the chunk jobs never shift
   * a part. `null` for a table without a primary key, which falls back to OFFSET.
   */
  key: ExportKey | null;
};

/** The source of an entity export: fixed list, restricted persons out, filters applied. */
export function entitySource(entity: ExportEntity, filters: ExportFilters = {}): ExportSource {
  const def = ENTITY_EXPORTS[entity];
  const parts: SQL[] = [];
  if (def.person === "t.id") parts.push(sql`t.processing_restricted_at is null`);
  else if (def.person) parts.push(sql.raw(`not exists (select 1 from persons rp where rp.id = ${def.person} and rp.processing_restricted_at is not null)`));
  const col = sql.raw(`t.${ident(def.dateColumn)}`);
  if (filters.from) parts.push(sql`${col} >= (${filters.from}::date::timestamp at time zone 'Europe/Brussels')`);
  if (filters.to) parts.push(sql`${col} < ((${filters.to}::date + 1)::timestamp at time zone 'Europe/Brussels')`);
  if (filters.segmentId && def.person) parts.push(sql`${sql.raw(def.person)} in (select sm.person_id from segment_members sm where sm.segment_id = ${filters.segmentId}::uuid)`);
  return {
    name: entity,
    table: def.table,
    columns: [...def.columns],
    excluded: [],
    select: sql.raw(def.columns.map((c) => `t.${ident(c)}`).join(", ")),
    where: parts.length ? sql.join(parts, sql` and `) : sql`true`,
    orderBy: sql`t.id`,
    key: { columns: ["id"], types: ["uuid"] },
  };
}

type ColumnInfo = { column: string; dataType: string };

async function tableColumns(db: DbOrTx, table: string): Promise<ColumnInfo[]> {
  return rowsOf<ColumnInfo>(
    await db.execute(sql`select column_name as "column", data_type as "dataType" from information_schema.columns
      where table_schema = 'public' and table_name = ${table} order by ordinal_position`),
  );
}

/** A Postgres type name as `format_type` prints it (`uuid`, `bigint`, `character varying(64)`, an enum name). */
const SAFE_TYPE = /^[a-z_][a-z0-9_ ]*(\([0-9, ]+\))?$/;

async function primaryKey(db: DbOrTx, table: string): Promise<ExportKey | null> {
  const rows = rowsOf<{ column: string; type: string }>(
    await db.execute(sql`select a.attname as "column", format_type(a.atttypid, a.atttypmod) as "type" from pg_index i
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = ${`public.${table}`}::regclass and i.indisprimary order by array_position(i.indkey, a.attnum)`),
  );
  if (!rows.length) return null;
  for (const r of rows) if (!SAFE_TYPE.test(r.type)) throw new Error(`unsafe type: ${r.type}`);
  return { columns: rows.map((r) => r.column), types: rows.map((r) => r.type) };
}

/** Every base table of the full export: the entity tables first (rule 54 order), then the rest by name. */
export async function fullExportTables(db: DbOrTx): Promise<string[]> {
  const rows = rowsOf<{ table: string }>(
    await db.execute(sql`select table_name as "table" from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`),
  );
  const all = rows.map((r) => r.table).filter((t) => SAFE_IDENT.test(t));
  const first = EXPORT_ENTITIES.map((e) => ENTITY_EXPORTS[e].table).filter((t) => all.includes(t));
  return [...first, ...all.filter((t) => !first.includes(t))];
}

/** The source of one table of the full export (rule 56): restricted persons included and flagged. */
export async function fullTableSource(db: DbOrTx, table: string): Promise<ExportSource> {
  const info = await tableColumns(db, table);
  if (!info.length) throw new Error(`unknown table: ${table}`);
  const entity = entityOfTable(table);
  const columns = entity ? [...ENTITY_EXPORTS[entity].columns] : info.filter((c) => !isExcludedColumn(table, c.column, c.dataType)).map((c) => c.column);
  const excluded = info.map((c) => c.column).filter((c) => !columns.includes(c));
  const projection = columns.map((c) => `t.${ident(c)}`);
  if (table === "persons") {
    projection.push("(t.processing_restricted_at is not null) as is_processing_restricted");
    columns.push("is_processing_restricted");
  }
  const pk = await primaryKey(db, table);
  // A key holding an excluded column (a token) is never written to `data_exports.cursor`: such a
  // table pages by OFFSET over its key order, as does a table without a primary key (none today,
  // ordered by its first column).
  const key = pk && pk.columns.every((c) => !excluded.includes(c)) ? pk : null;
  const order = (pk ? pk.columns : [info[0]!.column]).map((c) => `t.${ident(c)}`).join(", ");
  return { name: table, table, columns, excluded, select: sql.raw(projection.join(", ")), where: sql`true`, orderBy: sql.raw(order), key };
}

/** One chunk: the rows as value arrays in `source.columns` order and the key of its last row (as text). */
export type ExportChunk = { rows: unknown[][]; lastKey: string[] | null };

/**
 * One chunk of rows. With a key, the rows after `after` (the `lastKey` of the previous chunk;
 * `null` for the first chunk) in key order; each value is compared in its own column type. A
 * source without a key reads `limit` rows at `offset`.
 */
export async function readChunk(db: DbOrTx, source: ExportSource, after: readonly string[] | null, limit: number, offset = 0): Promise<ExportChunk> {
  const table = sql.raw(ident(source.table));
  if (!source.key) {
    const rows = rowsOf<Record<string, unknown>>(
      await db.execute(sql`select ${source.select} from ${table} t where ${source.where} order by ${source.orderBy} limit ${limit} offset ${offset}`),
    );
    return { rows: rows.map((r) => source.columns.map((c) => r[c] ?? null)), lastKey: null };
  }
  const { columns, types } = source.key;
  if (after && after.length !== columns.length) throw new Error(`export key mismatch: ${source.name}`);
  const keyCols = columns.map((c) => `t.${ident(c)}`);
  const keyText = sql.raw(keyCols.map((c, i) => `${c}::text as "__key_${i}"`).join(", "));
  const order = sql.raw(keyCols.join(", "));
  const past = after
    ? sql` and (${order}) > (${sql.join(after.map((v, i) => sql`${v}::${sql.raw(types[i]!)}`), sql`, `)})`
    : sql``;
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select ${source.select}, ${keyText} from ${table} t where ${source.where}${past} order by ${order} limit ${limit}`),
  );
  const last = rows[rows.length - 1];
  return {
    rows: rows.map((r) => source.columns.map((c) => r[c] ?? null)),
    lastKey: last ? columns.map((_, i) => String(last[`__key_${i}`])) : (after ? [...after] : null),
  };
}
