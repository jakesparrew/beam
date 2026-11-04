import { describe, expect, it } from "vitest";
import {
  ACTIVE_CAMPAIGN_STATUSES,
  assertTransition,
  CAMPAIGN_STATUSES,
  CampaignTransitionError,
  canTransition,
  isTerminalCampaignStatus,
  type CampaignStatus,
} from "./campaign-state";

/** Rule 25, written out independently of the implementation's table. */
const ALLOWED: [CampaignStatus, CampaignStatus][] = [
  ["draft", "planning"],
  ["planning", "scheduled"],
  ["scheduled", "sending"],
  ["sending", "sent"],
  ["sending", "paused"],
  ["paused", "sending"],
  ["paused", "sent"],
  ["sending", "stopped"],
  ["paused", "stopped"],
  ["draft", "cancelled"],
  ["scheduled", "cancelled"],
  ["scheduled", "draft"],
  ["planning", "draft"],
];

const key = (from: CampaignStatus, to: CampaignStatus) => `${from}->${to}`;
const allowed = new Set(ALLOWED.map(([f, t]) => key(f, t)));

describe("campaign states (rule 25)", () => {
  it.each(ALLOWED)("allows %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  const refused = CAMPAIGN_STATUSES.flatMap((from) => CAMPAIGN_STATUSES.map((to) => [from, to] as [CampaignStatus, CampaignStatus])).filter(
    ([f, t]) => !allowed.has(key(f, t)),
  );

  it("refuses every other pair (64 pairs, 13 allowed)", () => {
    expect(refused).toHaveLength(64 - ALLOWED.length);
  });

  it.each(refused)("refuses %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(CampaignTransitionError);
  });

  it("allows paused -> sent (resume with no planned recipient left)", () => {
    expect(canTransition("paused", "sent")).toBe(true);
  });

  it.each(["sent", "stopped", "cancelled"] as const)("refuses every move out of %s", (terminal) => {
    expect(isTerminalCampaignStatus(terminal)).toBe(true);
    for (const to of CAMPAIGN_STATUSES) expect(canTransition(terminal, to)).toBe(false);
  });

  it("does not allow skipping planning or sending, or unpausing into scheduled", () => {
    expect(canTransition("draft", "scheduled")).toBe(false);
    expect(canTransition("scheduled", "sent")).toBe(false);
    expect(canTransition("paused", "scheduled")).toBe(false);
    expect(canTransition("sending", "draft")).toBe(false);
    expect(canTransition("draft", "draft")).toBe(false);
  });

  it("lists the non-terminal statuses as active", () => {
    expect([...ACTIVE_CAMPAIGN_STATUSES]).toEqual(["draft", "planning", "scheduled", "sending", "paused"]);
  });

  it("names both statuses in the error", () => {
    try {
      assertTransition("sent", "sending");
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_transition", from: "sent", to: "sending", retryable: false });
    }
  });
});
