import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ruleAdvice, validateAdvice, type Flow } from "./advise";
import { computeBehaviour } from "./behaviour";

const now = new Date("2026-11-19T12:00:00Z");
const flows: Flow[] = [
  { slug: "inactivity", name: "Inactivity", description: "We-miss-you emails", isMarketing: true },
  { slug: "welcome-lead", name: "Welcome lead", description: "Welcome emails", isMarketing: true },
  { slug: "lead-sales-follow-up", name: "Lead sales follow-up", description: "Call tasks", isMarketing: false },
];
const facts = (over: Partial<Parameters<typeof computeBehaviour>[0]> = {}) =>
  computeBehaviour({ now, status: "lead", bookings: [], credits: [], isMember: false, paidCents: 0, paidOrders: 0, newsletter: true, activeFlows: [], ...over });
const rec = (type: "enrol" | "tag" | "task", extra: Record<string, string> = {}) => ({ type, title: "Doe iets", reason: "Omdat", ...extra });

describe("validateAdvice", () => {
  it("keeps an allowed journey, a known tag and a task, at most three", () => {
    const out = validateAdvice({ persona: "x", summary: "y", recommendations: [rec("enrol", { flow: "welcome-lead" }), rec("tag", { tag: "interest:night" }), rec("task"), rec("task")] }, facts(), flows);
    expect(out.map((r) => [r.type, r.flow ?? r.tag ?? null, r.status])).toEqual([["enrol", "welcome-lead", "open"], ["tag", "interest:night", "open"], ["task", null, "open"]]);
  });

  it("drops a journey that is not allowed, one the person is already in, and an unknown tag", () => {
    const out = validateAdvice(
      { persona: "x", summary: "y", recommendations: [rec("enrol", { flow: "package-usage" }), rec("enrol", { flow: "inactivity" }), rec("tag", { tag: "vip" })] },
      facts({ activeFlows: ["inactivity"] }),
      flows,
    );
    expect(out).toEqual([]);
  });

  it("never places someone without newsletter consent in a marketing journey", () => {
    const noConsent = facts({ newsletter: false });
    const out = validateAdvice({ persona: "x", summary: "y", recommendations: [rec("enrol", { flow: "welcome-lead" }), rec("enrol", { flow: "lead-sales-follow-up" })] }, noConsent, flows);
    expect(out.map((r) => r.flow)).toEqual(["lead-sales-follow-up"]);
  });
});

describe("ruleAdvice", () => {
  it("a new lead with consent gets the welcome journey and sales follow-up", () => {
    const f = facts();
    expect(validateAdvice(ruleAdvice(f, flows), f, flows).map((r) => r.flow)).toEqual(["welcome-lead", "lead-sales-follow-up"]);
  });

  it("a visitor without consent gets a task to ask for it, not a marketing journey", () => {
    const visit = { kind: "day" as const, startsAt: new Date(now.getTime() - 5 * 86_400_000), status: "attended" as const, createdAt: new Date(now.getTime() - 8 * 86_400_000), isGuest: false };
    const f = facts({ status: "customer", bookings: [visit], newsletter: false });
    const out = validateAdvice(ruleAdvice(f, flows), f, flows);
    expect(out.map((r) => r.type)).toEqual(["task"]);
  });
});
