/** Segment queries (crm spec 4.3), crm-P5. */
import type { DbOrTx } from "@beam/db";
import { segments } from "@beam/db/schema";
import {
  COMPARATORS,
  CONSENT_PURPOSES,
  formatCustomerNumber,
  SEGMENT_ALLOWED_EVENT_KINDS,
  SEGMENT_EVENT_DATA_KEYS,
  SEGMENT_FIELDS,
  segmentAudienceFragment,
  type SegmentRule,
} from "@beam/core/crm";
import { asc, eq, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { fragmentText, previewAudienceSql, storedAudienceSql, uuidArray } from "./sql";

export type SegmentRow = {
  id: string;
  name: string;
  description: string | null;
  kind: "dynamic" | "static";
  definition: SegmentRule;
  excludeSegmentIds: string[];
  isArchived: boolean;
  refreshError: string | null;
  lastCount: number | null;
  lastCountedAt: Date | null;
};

export type SegmentPersonRow = { id: string; customerNumber: string; name: string };

const columns = {
  id: segments.id,
  name: segments.name,
  description: segments.description,
  kind: segments.kind,
  definition: segments.definition,
  excludeSegmentIds: segments.excludeSegmentIds,
  isArchived: segments.isArchived,
  refreshError: segments.refreshError,
  lastCount: segments.lastCount,
  lastCountedAt: segments.lastCountedAt,
};

const toRow = (r: Omit<SegmentRow, "definition"> & { definition: unknown }): SegmentRow => ({ ...r, definition: r.definition as SegmentRule });

export async function listSegments(tx: DbOrTx, input: { includeArchived: boolean }): Promise<SegmentRow[]> {
  const rows = await tx
    .select(columns)
    .from(segments)
    .where(input.includeArchived ? undefined : eq(segments.isArchived, false))
    .orderBy(asc(segments.isArchived), asc(segments.name), asc(segments.id));
  return rows.map(toRow);
}

export async function getSegment(tx: DbOrTx, id: string): Promise<SegmentRow | null> {
  const [row] = await tx.select(columns).from(segments).where(eq(segments.id, id));
  return row ? toRow(row) : null;
}

type PersonSql = { id: string; customer_number: string | number; first_name: string | null; last_name: string | null };
const personView = (r: PersonSql): SegmentPersonRow => ({
  id: r.id,
  customerNumber: formatCustomerNumber(r.customer_number),
  name: [r.first_name, r.last_name].filter(Boolean).join(" ") || formatCustomerNumber(r.customer_number),
});

/** Live count and a 20-person sample; `sql` only for technical admins. Throws `SegmentRuleError`. */
export async function previewSegment(
  tx: DbOrTx,
  input: { definition: SegmentRule; excludeIds: string[]; showSql?: boolean; now?: Date },
): Promise<{ count: number; sample: Array<{ id: string; customerNumber: string; name: string }>; sql?: string }> {
  const now = input.now ?? new Date();
  const audience = previewAudienceSql(input.definition, input.excludeIds, now);
  const [counted] = rowsOf<{ n: number | string }>(await tx.execute(sql`select count(*)::int as n from (${audience}) a`));
  const sample = rowsOf<PersonSql>(
    await tx.execute(sql`
      select p.id, p.customer_number, p.first_name, p.last_name
      from persons p where p.id in (${audience})
      order by p.last_name nulls last, p.first_name nulls last, p.customer_number limit 20`),
  ).map(personView);
  return {
    count: Number(counted?.n ?? 0),
    sample,
    ...(input.showSql ? { sql: fragmentText(segmentAudienceFragment(input.definition, { now })) } : {}),
  };
}

/** One page of a segment's audience (after exclusions), for the segment page's member list. */
export async function listSegmentMembers(tx: DbOrTx, input: { segmentId: string; limit?: number; offset?: number }): Promise<{ total: number; rows: SegmentPersonRow[] }> {
  const audience = storedAudienceSql(input.segmentId);
  const [counted] = rowsOf<{ n: number | string }>(await tx.execute(sql`select count(*)::int as n from (${audience}) a`));
  const rows = rowsOf<PersonSql>(
    await tx.execute(sql`
      select p.id, p.customer_number, p.first_name, p.last_name
      from persons p where p.id in (${audience})
      order by p.last_name nulls last, p.first_name nulls last, p.customer_number
      limit ${Math.min(input.limit ?? 50, 200)} offset ${Math.max(0, input.offset ?? 0)}`),
  ).map(personView);
  return { total: Number(counted?.n ?? 0), rows };
}

/** Customer numbers (`C-000123` or `123`) to person ids, skipping unknown, erased and merged persons. */
export async function findPersonIdsByCustomerNumbers(tx: DbOrTx, numbers: readonly string[]): Promise<{ ids: string[]; unknown: string[] }> {
  const parsed = new Map<string, string>();
  for (const raw of numbers) {
    const digits = raw.trim().replace(/^C-?/i, "");
    if (/^\d{1,18}$/.test(digits)) parsed.set(String(BigInt(digits)), raw.trim());
  }
  const unknown = numbers.map((n) => n.trim()).filter((n) => n && !/^(C-?)?\d{1,18}$/i.test(n));
  if (!parsed.size) return { ids: [], unknown };
  const rows = rowsOf<{ id: string; customer_number: string | number }>(
    await tx.execute(sql`
      select id, customer_number from persons
      where customer_number = any(${`{${[...parsed.keys()].join(",")}}`}::bigint[]) and erased_at is null and merged_into_person_id is null`),
  );
  const found = new Set(rows.map((r) => String(r.customer_number)));
  for (const [n, raw] of parsed) if (!found.has(n)) unknown.push(raw);
  return { ids: rows.map((r) => r.id), unknown };
}

/** The segments a list of ids names (exclusion pickers, `in_segment` labels). */
export async function segmentNames(tx: DbOrTx, ids: readonly string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const rows = rowsOf<{ id: string; name: string }>(await tx.execute(sql`select id, name from segments where id = any(${uuidArray(ids)})`));
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

// ---------------------------------------------------------------------------
// Builder labels (server side; the client builder takes every string as a prop)
// ---------------------------------------------------------------------------

type Tr = (key: string, params?: Record<string, string | number>) => string;
type LabelOption = { value: string; label: string };

const BUILDER_KEYS = [
  "title_new", "title_edit", "name", "description", "kind", "rules", "add_rule", "add_group", "group_and", "group_or", "not", "remove",
  "rule_field", "rule_tag", "rule_consent", "rule_in_segment", "rule_event", "tag_has", "tag_has_not", "consent_granted", "consent_not_granted",
  "in_segment", "not_in_segment", "event_kind", "event_mode", "event_any_mode", "event_where", "event_negate", "value", "values", "days",
  "from", "to", "exclusions", "sample", "sample_empty", "refresh_now", "refresh_queued", "static_members", "add_member", "add_csv",
  "remove_member", "cycle", "too_many_rules", "too_deep", "sql",
] as const;

/**
 * Every string of the segment builder in one locale. `soft` translates keys of other modules'
 * catalogues (ops stages) and returns the key itself when missing; the raw value is shown then.
 */
export function segmentBuilderLabels(tr: Tr, soft: Tr, tagOptions: LabelOption[]) {
  const builder = Object.fromEntries(BUILDER_KEYS.map((k) => [k, tr(`crm.segments.builder.${k}`)])) as Record<string, string>;
  const pluralOf = (key: string, param: string) => ({ one: tr(key, { [param]: 1 }), other: tr(key, { [param]: 7 }) });
  const opts = (values: readonly string[], prefix: string, t: Tr = tr): LabelOption[] =>
    values.map((v) => {
      const key = `${prefix}.${v.replace("-", "_")}`;
      const label = t(key);
      return { value: v, label: label === key ? v : label };
    });
  const fieldOptions: Record<string, LabelOption[]> = { tags: tagOptions };
  for (const f of SEGMENT_FIELDS) {
    if (!f.options) continue;
    const prefix = { status: "crm.enums.person_status", locale: "crm.enums.locale", acquisition_source: "crm.enums.acquisition_source", b2c_stage: "ops.stage" }[f.column];
    fieldOptions[f.column] = prefix ? opts(f.options, prefix, prefix.startsWith("ops.") ? soft : tr) : f.options.map((v) => ({ value: v, label: v }));
  }
  return {
    builder,
    plural: {
      count: pluralOf("crm.segments.builder.count", "count"),
      minCount: pluralOf("crm.segments.builder.event_min_count", "count"),
      withinDays: pluralOf("crm.segments.builder.event_within_days", "days"),
    },
    comparators: Object.fromEntries(COMPARATORS.map((c) => [c, tr(`crm.segments.comparators.${c}`)])),
    fields: Object.fromEntries(SEGMENT_FIELDS.map((f) => [f.column, tr(f.label)])),
    fieldOptions,
    eventKinds: Object.fromEntries(SEGMENT_ALLOWED_EVENT_KINDS.map((k) => [k.replace(".", "_"), tr(`crm.segments.event_kinds.${k.replace(".", "_")}`)])),
    dataKeys: Object.fromEntries([...new Set(Object.values(SEGMENT_EVENT_DATA_KEYS).flat())].map((k) => [k, tr(`crm.segments.data_keys.${k}`)])),
    purposes: opts(CONSENT_PURPOSES, "crm.enums.consent_purpose"),
    kinds: opts(["dynamic", "static"], "crm.enums.segment_kind"),
    modes: opts(["live", "replay", "on_demand"], "crm.enums.activity_mode"),
    tags: tagOptions,
    common: {
      save: tr("crm.common.save"),
      saving: tr("crm.common.saving"),
      cancel: tr("crm.common.cancel"),
      error: tr("crm.common.error"),
      yes: tr("crm.common.yes"),
      no: tr("crm.common.no"),
      loading: tr("crm.common.loading"),
      search: tr("crm.common.search"),
      open: tr("crm.common.open"),
      required: tr("crm.common.required"),
    },
  };
}
