import { describe, expect, it } from "vitest";
import * as credits from "./index";
import { enumLabelKey, grantLabelKey, unitsLabelKey, unitsLabelValues } from "./wording";

describe("wording (rule 36)", () => {
  it("maps each kind to its units key, never to a 'credits' word", () => {
    expect(unitsLabelKey("day")).toBe("credits.units.day");
    expect(unitsLabelKey("night")).toBe("credits.units.night");
    expect(unitsLabelKey("euro")).toBe("credits.units.euro");
  });

  it("passes a count for units and an amount for euro", () => {
    expect(unitsLabelValues("day", 4)).toEqual({ count: 4 });
    expect(unitsLabelValues("euro", 3500)).toEqual({ amountCents: 3500 });
  });

  it("labels grants without a product name from the catalogue", () => {
    expect(grantLabelKey("voucher")).toBe("credits.labels.voucher");
    expect(grantLabelKey("import")).toBe("credits.labels.import");
    expect(grantLabelKey("referral")).toBe("credits.labels.referral_reward");
    expect(grantLabelKey("transfer")).toBe("credits.labels.transfer");
    expect(grantLabelKey("purchase")).toBeNull();
    expect(grantLabelKey("manual")).toBeNull();
  });

  it("builds enum label keys", () => {
    expect(enumLabelKey("grant_status", "exhausted")).toBe("credits.enum.grant_status.exhausted");
  });
});

describe("@beam/core/credits barrel", () => {
  it("exposes the package surface", () => {
    for (const name of [
      "computeExpiresAt",
      "expiresAt",
      "GRANT_TRANSITIONS",
      "MEMBERSHIP_TRANSITIONS",
      "assertGrantTransition",
      "assertMembershipTransition",
      "ConflictError",
      "CreditsSettings",
      "CreateGrantInput",
      "AdjustGrantInput",
      "ExtendGrantInput",
      "RevokeGrantInput",
      "TransferCreditsInput",
      "BulkExtendInput",
      "CancelMembershipInput",
      "ExtendMembershipPeriodInput",
      "PlanBenefitInput",
      "GrantSharingSchema",
      "GrantCreditsInputSchema",
      "allocateCredits",
      "crossedThresholds",
      "expiryWarningsDue",
      "nextPeriod",
      "dunningSchedule",
      "deriveStatus",
      "unitsLabelKey",
      "vatTreatmentFor",
    ]) {
      expect(credits, name).toHaveProperty(name);
    }
  });
});
