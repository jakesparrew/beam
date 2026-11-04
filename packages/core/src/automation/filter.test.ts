import { describe, expect, it } from "vitest";
import {
  eventEligibility,
  eventSubjectKey,
  matchesFilter,
  matchesTrigger,
  matchesValue,
  readPath,
  resolveLiteral,
  type EventView,
} from "./filter";

const NOW = new Date("2026-11-04T12:00:00Z");
const ev = (over: Partial<EventView> = {}): EventView => ({
  id: 10n,
  kind: "booking.confirmed",
  personId: "p1",
  occurredAt: new Date("2026-11-04T11:59:00Z"),
  mode: "live",
  refType: "booking",
  refId: "b1",
  data: { session_kind: "event", is_first_booking: true, total_cents: 30000, starts_at: "2026-11-08T09:00:00Z", nested: { a: 1 }, nil: null },
  ...over,
});

describe("readPath", () => {
  it("reads data paths, mode and refs; missing is undefined", () => {
    const e = ev();
    expect(readPath(e, "data.session_kind")).toBe("event");
    expect(readPath(e, "data.nested.a")).toBe(1);
    expect(readPath(e, "data.nil")).toBeNull();
    expect(readPath(e, "data.missing")).toBeUndefined();
    expect(readPath(e, "data.nested.a.b")).toBeUndefined();
    expect(readPath(e, "data.session_kind.x")).toBeUndefined();
    expect(readPath(e, "mode")).toBe("live");
    expect(readPath(e, "ref_type")).toBe("booking");
    expect(readPath(e, "ref_id")).toBe("b1");
    expect(readPath(ev({ mode: null }), "mode")).toBeUndefined();
    expect(readPath(e, "kind")).toBeUndefined();
  });
});

describe("matchesValue: each operator", () => {
  it("literal equality, including null and booleans", () => {
    expect(matchesValue("event", "event")).toBe(true);
    expect(matchesValue("day", "event")).toBe(false);
    expect(matchesValue(true, true)).toBe(true);
    expect(matchesValue(null, null)).toBe(true);
    expect(matchesValue(1, "1")).toBe(false);
  });
  it("eq, ne, in, nin", () => {
    expect(matchesValue("a", { eq: "a" })).toBe(true);
    expect(matchesValue("a", { eq: "b" })).toBe(false);
    expect(matchesValue("a", { ne: "b" })).toBe(true);
    expect(matchesValue("a", { ne: "a" })).toBe(false);
    expect(matchesValue(30, { in: [30, 60] })).toBe(true);
    expect(matchesValue(45, { in: [30, 60] })).toBe(false);
    expect(matchesValue("web", { nin: ["import", "manual"] })).toBe(true);
    expect(matchesValue("import", { nin: ["import", "manual"] })).toBe(false);
  });
  it("gt, gte, lt, lte on numbers and ISO strings; mixed types fail", () => {
    expect(matchesValue(30000, { gte: 30000 })).toBe(true);
    expect(matchesValue(29999, { gte: 30000 })).toBe(false);
    expect(matchesValue(5, { gt: 4, lt: 6 })).toBe(true);
    expect(matchesValue(6, { gt: 4, lt: 6 })).toBe(false);
    expect(matchesValue(6, { lte: 6 })).toBe(true);
    expect(matchesValue(7, { lte: 6 })).toBe(false);
    expect(matchesValue(4, { gt: 4 })).toBe(false);
    expect(matchesValue("2026-11-08", { gt: "2026-11-01" })).toBe(true);
    expect(matchesValue("2026-10-08", { gte: "2026-11-01" })).toBe(false);
    expect(matchesValue("5", { gt: 4 })).toBe(false);
  });
  it("exists, and a missing path fails every operator except exists: false", () => {
    expect(matchesValue("x", { exists: true })).toBe(true);
    expect(matchesValue(null, { exists: true })).toBe(false);
    expect(matchesValue(null, { exists: false })).toBe(true);
    expect(matchesValue(undefined, { exists: false })).toBe(true);
    expect(matchesValue(undefined, { exists: true })).toBe(false);
    for (const op of [{ eq: "a" }, { ne: "a" }, { in: ["a"] }, { nin: ["a"] }, { gt: 1 }, { gte: 1 }, { lt: 1 }, { lte: 1 }])
      expect(matchesValue(undefined, op)).toBe(false);
    expect(matchesValue(undefined, "a")).toBe(false);
    expect(matchesValue(undefined, null)).toBe(false);
  });
  it("resolves {{trigger.data.<key>}} literals against vars", () => {
    const vars = { trigger: { data: { credit_kind: "day" } } };
    expect(resolveLiteral("{{trigger.data.credit_kind}}", vars)).toBe("day");
    expect(resolveLiteral("plain", vars)).toBe("plain");
    expect(matchesValue("day", "{{trigger.data.credit_kind}}", vars)).toBe(true);
    expect(matchesValue("night", "{{trigger.data.credit_kind}}", vars)).toBe(false);
    expect(matchesValue("day", { in: ["{{trigger.data.credit_kind}}"] }, vars)).toBe(true);
    expect(matchesValue("day", "{{trigger.data.credit_kind}}")).toBe(false);
  });
});

describe("matchesFilter and matchesTrigger (A-10)", () => {
  it("every path must match; no where matches all", () => {
    expect(matchesFilter(undefined, ev())).toBe(true);
    expect(matchesFilter({ "data.session_kind": "event", mode: "live" }, ev())).toBe(true);
    expect(matchesFilter({ "data.session_kind": "event", mode: "replay" }, ev())).toBe(false);
    expect(matchesFilter({ "data.missing": { exists: false }, ref_type: "booking" }, ev())).toBe(true);
    expect(matchesFilter({ "data.missing": "x" }, ev())).toBe(false);
  });

  it("a trigger with one kind or a list of kinds", () => {
    expect(matchesTrigger({ event: "booking.confirmed", where: { "data.session_kind": "event" } }, ev())).toBe(true);
    expect(matchesTrigger({ event: "booking.attended" }, ev())).toBe(false);
    expect(matchesTrigger({ event: ["booking.attended", "booking.confirmed"] }, ev())).toBe(true);
    expect(matchesTrigger({ event: ["booking.attended", "booking.no_show"] }, ev())).toBe(false);
    expect(matchesTrigger({ event: ["booking.confirmed"], where: { "data.session_kind": "day" } }, ev())).toBe(false);
  });

  it("segment_enter matches segment.entered of that segment; manual never matches", () => {
    const seg = ev({ kind: "segment.entered", data: { segment_id: "s1" } });
    expect(matchesTrigger({ segment_enter: "s1" }, seg)).toBe(true);
    expect(matchesTrigger({ segment_enter: "s2" }, seg)).toBe(false);
    expect(matchesTrigger({ segment_enter: "s1" }, ev())).toBe(false);
    expect(matchesTrigger({ manual: true }, seg)).toBe(false);
  });
});

describe("eventEligibility (A-7)", () => {
  it("sensitive and automation.* events never trigger nor exit", () => {
    expect(eventEligibility(ev({ isSensitive: true }), NOW)).toEqual({ trigger: false, exit: false, reason: "sensitive" });
    expect(eventEligibility(ev({ kind: "automation.entered" }), NOW)).toMatchObject({ trigger: false, exit: false });
  });
  it("imported, history, stale and automation-caused events exit but never trigger", () => {
    expect(eventEligibility(ev({ data: { source: "import" } }), NOW)).toEqual({ trigger: false, exit: true, reason: "imported" });
    expect(eventEligibility(ev({ data: { via_import: true } }), NOW).reason).toBe("imported");
    expect(eventEligibility(ev({ kind: "ops.history_imported" }), NOW).reason).toBe("history_imported");
    expect(eventEligibility(ev({ data: { source: "automation" } }), NOW).reason).toBe("automation_source");
    expect(eventEligibility(ev({ occurredAt: new Date("2026-11-02T11:00:00Z") }), NOW)).toEqual({ trigger: false, exit: true, reason: "stale" });
    expect(eventEligibility(ev({ occurredAt: new Date("2026-11-02T13:00:00Z") }), NOW)).toEqual({ trigger: true, exit: true, reason: null });
  });
  it("a live exhaustion or expiry of an imported grant still triggers; credits.granted of the import does not", () => {
    const fresh = { occurredAt: new Date("2026-11-04T11:00:00Z"), refType: "credit_grant", refId: "g1" };
    expect(eventEligibility(ev({ ...fresh, kind: "credits.grant_exhausted", data: { source: "import" } }), NOW)).toEqual({ trigger: true, exit: true, reason: null });
    expect(eventEligibility(ev({ ...fresh, kind: "credits.grant_expired", data: { source: "import" } }), NOW)).toEqual({ trigger: true, exit: true, reason: null });
    expect(eventEligibility(ev({ ...fresh, kind: "credits.granted", data: { source: "import" } }), NOW)).toEqual({ trigger: false, exit: true, reason: "imported" });
    expect(eventEligibility(ev({ ...fresh, kind: "credits.grant_exhausted", data: { source: "import", via_import: true } }), NOW).reason).toBe("imported");
    expect(eventEligibility(ev({ kind: "credits.grant_exhausted", occurredAt: new Date("2026-11-01T11:00:00Z"), data: { source: "import" } }), NOW).reason).toBe("stale");
  });
  it("subject keys", () => {
    expect(eventSubjectKey(ev())).toBe("booking:b1");
    expect(eventSubjectKey(ev({ refType: null }))).toBe("");
  });
});
