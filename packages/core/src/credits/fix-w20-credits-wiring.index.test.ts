/**
 * fix-w20-credits-wiring: the `@beam/core/credits` barrel re-exports the R3 referral rules
 * (credits-P9 request) and no longer carries the Wave 0 `SharingReviewRow` guess (credits-P8
 * request; the real row type lives in `apps/web/modules/credits/server/sharing.ts`).
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import * as credits from "./index";
import * as referrals from "./referrals";

describe("@beam/core/credits barrel", () => {
  it("re-exports every runtime export of referrals.ts", () => {
    const barrel = credits as Record<string, unknown>;
    for (const [name, value] of Object.entries(referrals)) expect(barrel[name], name).toBe(value);
  });

  it("serves the referral settings through the barrel", () => {
    expect(credits.ReferralsSettings.parse(credits.REFERRALS_SETTINGS_DEFAULTS)).toEqual(credits.REFERRALS_SETTINGS_DEFAULTS);
    expect(credits.isValidReferralCode(credits.generateReferralCode())).toBe(true);
  });

  it("no longer exports the Wave 0 SharingReviewRow guess", () => {
    // `pnpm typecheck` fails here (unused @ts-expect-error) if the guess ever comes back.
    // @ts-expect-error SharingReviewRow is exported by apps/web/modules/credits/api.ts, not by core.
    type Guess = credits.SharingReviewRow;
    expectTypeOf<Guess>().toBeAny();
    expect("SharingReviewRow" in credits).toBe(false);
  });
});
