"use server";
/**
 * ops server actions, area `stats` (ops spec 4.1, rule 7): "Recalculate" on the person page.
 * `persons.read` is enough: the stats are derived data and the action only refreshes the cache.
 * Audited as `stats.recalculated` (entity `person`, no values).
 */
import { RecalculatePersonStatsInput } from "@beam/core/ops";
import { action } from "@/lib/action";
import { refreshPersonStats } from "./api";

export const recalculatePersonStats = action(
  { name: "ops.recalculate_stats", audience: "staff", permission: "persons.read", input: RecalculatePersonStatsInput, audit: false },
  async (ctx, input) => {
    const stats = await refreshPersonStats(ctx.tx, input.personId);
    await ctx.audit({ action: "stats.recalculated", entityType: "person", entityId: input.personId, personId: input.personId });
    return stats;
  },
);
