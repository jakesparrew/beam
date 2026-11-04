/**
 * credits jobs (`defineJob`, credits spec section 4 "Jobs"). Facade read by `pnpm gen:indexes`.
 * credits-P3: the expiry scan, the per-grant expiry and the bulk extension. Membership renewals
 * (credits-P4) and `ledger.reconcile` (credits-P5) are added by their packages.
 */
import { z } from "zod";
import { brusselsDateKey, expireEntryKey, expiryWarningDedupeKey, expiryWarningsDue } from "@beam/core/credits";
import { defineJob, type JobCtx } from "@/lib/job-runner";
import { runBulkExtension } from "./server/bulk-extend";
import { creditsSettings, dueExpiries, expireGrant, expiryWarningCandidates } from "./server/ledger";

/** Grants handled per `credits.expire_grants` run before it continues itself. */
export const EXPIRE_CHUNK = 500;

export const ExpireGrantsInput = z.object({
  runOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  afterId: z.uuid().optional(),
});
export const ExpireGrantInput = z.object({ grantId: z.uuid() });
export const BulkExtendJobInput = z.object({ bulkExtensionId: z.uuid(), afterId: z.uuid().optional() });

/**
 * `credits.expire_grants` (daily 00:05 Brussels): enqueues `credits.expire_grant` for every active
 * grant with `expires_at <= now` (500 per run, self-continuing with `afterId`, key
 * `expire_grants:<runOn>:after:<afterId>`), and on the first run of the day records
 * `credits.expiry_approaching` once per grant and window (rule 30, edge case 23).
 */
export async function runExpireGrants(ctx: JobCtx, input: z.infer<typeof ExpireGrantsInput>): Promise<{ enqueued: number; warnings: number; continued: boolean }> {
  const runOn = input.runOn ?? brusselsDateKey(ctx.now);
  const due = await dueExpiries(ctx.tx, ctx.now, input.afterId, EXPIRE_CHUNK);
  for (const g of due) {
    await ctx.enqueue({ kind: "credits.expire_grant", payload: { grantId: g.id }, key: expireEntryKey(g.id, g.expiresAt) });
  }
  const last = due.at(-1)?.id;
  const continued = due.length === EXPIRE_CHUNK && !!last;
  if (continued) {
    await ctx.enqueue({ kind: "credits.expire_grants", payload: { runOn, afterId: last }, key: `expire_grants:${runOn}:after:${last}` });
  }

  let warnings = 0;
  if (!input.afterId) {
    const settings = await creditsSettings(ctx.tx);
    const days = [...settings.expiry_warning_days];
    if (days.length) {
      for (const g of await expiryWarningCandidates(ctx.tx, ctx.now, Math.max(...days))) {
        for (const d of expiryWarningsDue(g.expiresAt, ctx.now, days)) {
          const r = await ctx.recordEvent({
            kind: "credits.expiry_approaching",
            personId: g.personId,
            ref: { type: "credit_grant", id: g.grantId },
            dedupeKey: expiryWarningDedupeKey(g.grantId, d, g.expiresAt),
            data: { grant_id: g.grantId, credit_kind: g.creditKind, days: d, remaining_units: g.remainingUnits },
          });
          if (r.id !== null) warnings += 1;
        }
      }
    }
  }
  return { enqueued: due.length, warnings, continued };
}

export async function runExpireGrant(ctx: JobCtx, input: z.infer<typeof ExpireGrantInput>): Promise<{ expired: boolean; units: number }> {
  return expireGrant(ctx.tx, ctx, input.grantId);
}

export async function runBulkExtend(ctx: JobCtx, input: z.infer<typeof BulkExtendJobInput>) {
  return runBulkExtension(ctx, input);
}

export const jobs = [
  defineJob({ kind: "credits.expire_grants", lane: "bulk", priority: 5, maxAttempts: 6, input: ExpireGrantsInput, run: runExpireGrants }),
  defineJob({ kind: "credits.expire_grant", lane: "fast", priority: 5, maxAttempts: 6, input: ExpireGrantInput, run: runExpireGrant }),
  defineJob({ kind: "credits.bulk_extend", lane: "bulk", priority: 9, maxAttempts: 6, input: BulkExtendJobInput, run: runBulkExtend }),
];
