/**
 * Turns the pure compiler's `SqlFragment` (crm spec 4.6) into a Drizzle `SQL` with `sql.join`:
 * text pieces become raw SQL (they only ever hold compiler text and allow-listed column names),
 * every `{ param }` becomes a bound parameter. Arrays are bound as one Postgres array literal so
 * a `::text[]` cast receives one value, not a spread list.
 *
 * Also builds the audience SQL of stored segments (rule 3.39): members minus erased, merged and
 * restricted persons, minus the members of every excluded segment, applied at read time.
 */
import { compileSegment, segmentAudienceFragment, type SqlFragment } from "@beam/core/crm";
import { sql, type SQL } from "@/lib/ctx";

/** A Postgres array literal (`{"a","b"}`) with every element quoted and escaped. */
export function pgArrayLiteral(values: readonly unknown[]): string {
  const text = (v: unknown) => (typeof v === "object" ? JSON.stringify(v) : String(v as string | number | boolean | bigint));
  const quote = (v: unknown) => (v === null || v === undefined ? "NULL" : `"${text(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${values.map(quote).join(",")}}`;
}

/** Joins a fragment into one Drizzle `SQL`; values are always bound parameters. */
export function fragmentToSql(fragment: SqlFragment): SQL {
  const parts = fragment.map((piece) => {
    if (typeof piece === "string") return sql.raw(piece);
    const value = Array.isArray(piece.param) ? pgArrayLiteral(piece.param) : piece.param;
    return sql`${value}`;
  });
  return sql.join(parts, sql.raw(""));
}

/** The compiled rule as a boolean expression over `v` (a `v_person_profile` row). Throws `SegmentRuleError`. */
export function ruleConditionSql(rule: unknown, now: Date): SQL {
  return fragmentToSql(compileSegment(rule, { now }));
}

/**
 * `select v.person_id from v_person_profile v join persons p … where <not erased, merged or
 * restricted> and (<rule>)`: the raw result of a dynamic rule. Throws `SegmentRuleError`.
 */
export function ruleAudienceSql(rule: unknown, now: Date): SQL {
  return fragmentToSql(segmentAudienceFragment(rule, { now }));
}

/** Persons that may appear in any audience (rule 3.22): not erased, not merged, not restricted. */
export const ELIGIBLE_PERSON = sql.raw("p.erased_at is null and p.merged_into_person_id is null and p.processing_restricted_at is null");

/** `uuid[]` parameter of a list of ids. */
export const uuidArray = (ids: readonly string[]): SQL => sql`${pgArrayLiteral(ids)}::uuid[]`;

/**
 * `select person_id …` of a stored segment's audience (rule 3.39): its raw member set minus
 * erased, merged and restricted persons, minus every member of the segment's own
 * `exclude_segment_ids` and of `excludeSegmentIds`. Exclusions are one level, not recursive.
 */
export function storedAudienceSql(segmentId: string, excludeSegmentIds: readonly string[] = []): SQL {
  return sql`select sm.person_id from segment_members sm join persons p on p.id = sm.person_id
    where sm.segment_id = ${segmentId}::uuid and ${ELIGIBLE_PERSON}
      and not exists (
        select 1 from segment_members x
        where x.person_id = sm.person_id
          and x.segment_id = any(coalesce((select s.exclude_segment_ids from segments s where s.id = ${segmentId}::uuid), '{}'::uuid[]) || ${uuidArray(excludeSegmentIds)})
      )`;
}

/** The preview audience of an unsaved rule: the rule result minus the members of `excludeIds`. */
export function previewAudienceSql(rule: unknown, excludeIds: readonly string[], now: Date): SQL {
  return sql`select a.person_id from (${ruleAudienceSql(rule, now)}) a
    where not exists (select 1 from segment_members x where x.person_id = a.person_id and x.segment_id = any(${uuidArray(excludeIds)}))`;
}

/** The SQL text of a fragment with `$n` placeholders (technical admins' preview). */
export function fragmentText(fragment: SqlFragment): string {
  let n = 0;
  return fragment.map((f) => (typeof f === "string" ? f : `$${++n}`)).join("");
}
