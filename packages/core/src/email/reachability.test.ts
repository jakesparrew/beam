import { describe, expect, it } from "vitest";
import { BLOCKED_REASONS, recipientSkipStatus, resolveReachability, type ReachabilityInput } from "./reachability";

const reachable: ReachabilityInput = { erased: false, hasEmail: true, restricted: false, isSuppressed: false, consentStatus: "granted" };
/** Everything wrong at once. */
const worst: ReachabilityInput = { erased: true, hasEmail: false, restricted: true, isSuppressed: true, consentStatus: "withdrawn" };

describe("resolveReachability (mirrors v_marketing_reachability)", () => {
  it("is reachable only when granted and not suppressed (and the person is fine)", () => {
    expect(resolveReachability(reachable)).toBeNull();
    const combos: ReachabilityInput[] = [];
    for (const erased of [false, true])
      for (const hasEmail of [false, true])
        for (const restricted of [false, true])
          for (const isSuppressed of [false, true])
            for (const consentStatus of ["granted", "withdrawn", null] as const) combos.push({ erased, hasEmail, restricted, isSuppressed, consentStatus });
    const reachableCombos = combos.filter((c) => resolveReachability(c) === null);
    expect(reachableCombos).toEqual([reachable]);
  });

  it("orders reasons: erased, no_email, restricted, suppressed, withdrawn, no_consent", () => {
    let input: ReachabilityInput = { ...worst };
    expect(resolveReachability(input)).toBe("erased");
    input = { ...input, erased: false };
    expect(resolveReachability(input)).toBe("no_email");
    input = { ...input, hasEmail: true };
    expect(resolveReachability(input)).toBe("restricted");
    input = { ...input, restricted: false };
    expect(resolveReachability(input)).toBe("suppressed");
    input = { ...input, isSuppressed: false };
    expect(resolveReachability(input)).toBe("withdrawn");
    input = { ...input, consentStatus: null };
    expect(resolveReachability(input)).toBe("no_consent");
    expect(BLOCKED_REASONS).toEqual(["erased", "no_email", "restricted", "suppressed", "withdrawn", "no_consent"]);
  });

  it("blocks a suppressed person even with a granted consent", () => {
    expect(resolveReachability({ ...reachable, isSuppressed: true })).toBe("suppressed");
  });

  it("maps reasons to the chunk's recipient status (rule 32)", () => {
    expect(recipientSkipStatus("suppressed")).toBe("skipped_suppressed");
    expect(recipientSkipStatus("withdrawn")).toBe("skipped_consent");
    expect(recipientSkipStatus("no_consent")).toBe("skipped_consent");
    for (const r of ["erased", "no_email", "restricted"] as const) expect(recipientSkipStatus(r)).toBe("skipped_unreachable");
  });
});
