/**
 * Test fixtures of crm-P5's segment suites. `ensurePersonProfileView` creates a fixture
 * `v_person_profile` with the contract columns when ops' view is absent (a database built
 * before ops-P2); with ops' view present it changes nothing. `PROFILE_FIXTURE_COLUMNS` is the
 * column list `segment-fields.test.ts` falls back to until ops' `PERSON_PROFILE_COLUMNS` exists.
 */
import type { DbOrTx } from "@beam/db";
import { segments } from "@beam/db/schema";
import { SEGMENT_FIELDS, type SegmentFieldType, type SegmentRule } from "@beam/core/crm";
import { sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";

const PG_TYPE: Record<SegmentFieldType, string> = {
  enum: "text",
  text: "text",
  number: "integer",
  timestamp: "timestamptz",
  "text[]": "text[]",
  boolean: "boolean",
};

/** The contract columns of `v_person_profile` the segment compiler reads (crm spec 4.6). */
export const PROFILE_FIXTURE_COLUMNS: readonly string[] = ["person_id", ...SEGMENT_FIELDS.map((f) => f.column)];

/** Creates the fixture view when `v_person_profile` does not exist; returns whether it did. */
export async function ensurePersonProfileView(db: DbOrTx): Promise<boolean> {
  const [row] = rowsOf<{ exists: boolean }>(await db.execute(sql`select to_regclass('public.v_person_profile') is not null as exists`));
  if (row?.exists) return false;
  const cols = SEGMENT_FIELDS.map((f) => {
    if (f.column === "locale") return "p.locale::text as locale";
    if (f.column === "created_at") return "p.created_at";
    if (f.column === "is_tester") return "p.is_tester";
    return `null::${PG_TYPE[f.type]} as ${f.column}`;
  });
  await db.execute(sql.raw(`create view v_person_profile as select p.id as person_id, ${cols.join(", ")} from persons p`));
  return true;
}

/** Inserts a segment row directly (no validation; tests of stored rules). */
export async function insertSegment(
  db: DbOrTx,
  input: { name?: string; kind?: "dynamic" | "static"; definition?: SegmentRule | Record<string, unknown>; excludeSegmentIds?: string[]; isArchived?: boolean },
): Promise<string> {
  const [row] = await db
    .insert(segments)
    .values({
      name: input.name ?? "Fixture segment",
      kind: input.kind ?? "dynamic",
      definition: (input.definition ?? { op: "and", rules: [] }) as Record<string, unknown>,
      excludeSegmentIds: input.excludeSegmentIds ?? [],
      isArchived: input.isArchived ?? false,
    })
    .returning({ id: segments.id });
  return row!.id;
}

/** A rule matching exactly the persons that carry `tagKey`. */
export const tagRule = (tagKey: string): SegmentRule => ({ op: "and", rules: [{ type: "tag", tagKey, has: true }] });
