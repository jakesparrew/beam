"use server";
/**
 * ops server actions, area `marketing` (ops spec 4.1, R3): `pullAdsNow`, the ads screen's
 * "Pull now" button. It enqueues one `ads.backfill` per configured account over the last `days`
 * days up to yesterday (`settings.write`, audit `ads.pull_requested`). The account form of the
 * same screen submits platform's `updateSetting({ key: 'ads', ... })`; ops has no settings action
 * of its own (cross-module decision 17). A "use server" file exports async functions only.
 */
import { PullAdsNowInput } from "@beam/core/ops";
import { action } from "@/lib/action";
import { requestAdsPull } from "./ads";

/** `ops.ads_pull_now`: re-pull the last `days` days (1-90) of every configured ad account. */
export const pullAdsNow = action(
  { name: "ops.ads_pull_now", audience: "staff", permission: "settings.write", input: PullAdsNowInput, audit: false },
  async (ctx, input) => {
    const { jobIds, from, to } = await requestAdsPull(ctx, input);
    await ctx.audit({ action: "ads.pull_requested", entityType: "setting", entityId: null, newValue: { days: input.days, from, to, jobs: jobIds.length } });
    return { jobIds };
  },
);
