/**
 * The DPIA register (ops rule 70, blueprint 66, ops-P6): which features each DPIA gates and the
 * status read behind `isDpiaApproved`. A gated feature stays off until its `dpia_records.status`
 * is `approved` or `not_required`; a missing row counts as `not_started`.
 *
 * The gates of a key are the features of `DPIA_GATED`, the `v_person_profile` columns marked
 * with that DPIA (`PERSON_PROFILE_COLUMNS[].dpia`, the watch-time segment fields) and every
 * automation journey whose seed-only column `automations.requires_dpia` names the key (the
 * webinar behaviour journeys for `watch_time_profiling`).
 */
import type { DbOrTx } from "@beam/db";
import { automations, dpiaRecords } from "@beam/db/schema";
import { DPIA_GATED, DPIA_KEYS, isDpiaStatusApproved, PERSON_PROFILE_COLUMNS, type DpiaKey, type DpiaStatus } from "@beam/core/ops";
import { asc, eq, isNotNull } from "@/lib/ctx";

export type DpiaGates = Record<DpiaKey, string[]>;

/** The status of one DPIA; `not_started` when the row is missing. */
export async function getDpiaStatus(db: DbOrTx, key: DpiaKey): Promise<DpiaStatus> {
  const [row] = await db.select({ status: dpiaRecords.status }).from(dpiaRecords).where(eq(dpiaRecords.key, key)).limit(1);
  return row?.status ?? "not_started";
}

/** Rule 70: the one check. */
export async function dpiaApproved(db: DbOrTx, key: DpiaKey): Promise<boolean> {
  return isDpiaStatusApproved(await getDpiaStatus(db, key));
}

/** Profile columns that exist only while the DPIA is approved. */
export function dpiaProfileFields(key: DpiaKey): string[] {
  return PERSON_PROFILE_COLUMNS.filter((c) => c.dpia === key).map((c) => `v_person_profile.${c.name}`);
}

/** Every gate of every DPIA key: features, profile fields and automation journeys (`automation:<slug>`). */
export async function listDpiaGates(db: DbOrTx): Promise<DpiaGates> {
  const journeys = await db
    .select({ slug: automations.slug, requiresDpia: automations.requiresDpia })
    .from(automations)
    .where(isNotNull(automations.requiresDpia))
    .orderBy(asc(automations.slug));
  const gates = {} as DpiaGates;
  for (const key of DPIA_KEYS) {
    gates[key] = [...DPIA_GATED[key], ...dpiaProfileFields(key), ...journeys.filter((j) => j.requiresDpia === key).map((j) => `automation:${j.slug}`)];
  }
  return gates;
}
