/**
 * ops cross-module api, area `dashboard` (ops spec 4.7). `../api.ts` re-exports this file so a
 * later function needs no facade edit.
 */
import type { DbOrTx } from "@beam/db";
import type { DayClient, Opportunity } from "./daily";

export type { DayClient, Opportunity, OpportunityKey } from "./daily";

/**
 * crm's 360 "Opvolging" (owner review November 2026): one person as the dashboard's day list sees
 * them (membership, free member credits, bought packages, first visit) and the opportunities the
 * dashboard derives from that, with the same `clientOpportunities` rules. Null for an unknown id.
 * Loaded on first call: `daily.ts` reaches crm's api through the action cards, and crm imports this.
 */
export async function getPersonOpportunities(
  db: DbOrTx,
  input: { personId: string; now: Date },
): Promise<{ client: DayClient; opportunities: Opportunity[] } | null> {
  const daily = await import("./daily");
  const client = await daily.getClientSnapshot(db, input);
  return client
    ? { client, opportunities: daily.clientOpportunities(client, input.now) }
    : null;
}
