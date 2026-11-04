/**
 * ops queries, area `stats` (ops spec 4.2): the person page stats panel. Each query calls
 * `requirePermission` first and selects named columns only. Other modules read ops through
 * `../api.ts`, never this file.
 */
import type { DbOrTx } from "@beam/db";
import { requirePermission } from "@/lib/auth";
import { getPersonStats, listRetentionReasons, type PersonStats } from "./api";

export type PersonStatsPanel = {
  stats: PersonStats | null;
  reasons: Awaited<ReturnType<typeof listRetentionReasons>>;
};

/** The stats card of the person page (`persons.read`): the cached row and the retention reasons. */
export async function getPersonStatsPanel(db: DbOrTx, personId: string): Promise<PersonStatsPanel> {
  await requirePermission("persons.read");
  const stats = await getPersonStats(db, personId);
  const reasons = await listRetentionReasons(db, personId);
  return { stats, reasons };
}
