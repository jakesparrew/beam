import { describe, expect, it } from "vitest";
import { AutomationDefinition, parseDefinition, reEntryDays, triggerKinds, type Definition } from "./definition";
import { canonicalJson, diffDefinitions } from "./diff";

/** `event-registration` (section 3.6) plus one step of every other type. */
const FULL: Definition = {
  schema_version: 1,
  trigger: { event: "booking.confirmed", where: { "data.session_kind": "event", mode: { in: ["live", null] } } },
  anchor: "data.starts_at",
  subject: "ref",
  audience: { status: ["lead", "customer"], locales: ["nl-BE", "fr-BE", "en"], require_reachable: false },
  re_entry: "always",
  exit_on: ["booking.cancelled", "order.paid:package", { event: "booking.late_cancelled", same_subject: true }],
  steps: [
    { key: "reminder_7d", type: "email", template: "automation.event_reminder_7d", at: { from: "anchor", minutes: -10080 } },
    { key: "reminder_3d", type: "email", template: "automation.event_reminder_3d", at: { from: "anchor", minutes: -4320, snap_to: "10:00" } },
    { key: "pause", type: "wait", minutes: 60 },
    {
      key: "check",
      type: "condition",
      if: { any: [{ has_future_booking: { kind: "event", within_days: 7 } }, { not: { has_tag: "vip" } }] },
      then: "task_1",
      else: "end",
    },
    { key: "task_1", type: "task", title: "Call", kind: "call", owner_role: "sales", due_in_minutes: 60, priority: "normal" },
    { key: "tag_1", type: "tag", tag: "engaged", unless: { processing_restricted: true } },
    { key: "untag_1", type: "untag", tag: "engaged" },
    { key: "field_1", type: "set_field", field: "preferred_channel", value: "email" },
    { key: "status_1", type: "status_override", value: null, reason: "reset" },
    { key: "enrol_1", type: "enrol", automation: "welcome-lead" },
    { key: "exit_1", type: "exit" },
    { key: "slack_1", type: "notify_slack", text: "{{first_name}} entered {{automation}}" },
    { key: "hook_1", type: "webhook", url: "https://hooks.example.com/beam", late_entry: "send_now" },
  ],
};

describe("AutomationDefinition", () => {
  it("round trips a definition with every step type", () => {
    const parsed = parseDefinition(JSON.parse(JSON.stringify(FULL)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(canonicalJson(parsed.value)).toBe(canonicalJson(FULL));
    expect(AutomationDefinition.parse(parsed.value)).toEqual(parsed.value);
  });

  it("rejects unknown keys at every level (strict)", () => {
    const top = parseDefinition({ ...FULL, group: "webinar" });
    expect(top.ok).toBe(false);
    if (!top.ok) expect(top.issues[0]).toMatchObject({ code: "unknown_key", severity: "error" });

    const inStep = parseDefinition({ ...FULL, steps: [{ ...FULL.steps[0], subject: "x" }] });
    expect(inStep.ok).toBe(false);

    const inAudience = parseDefinition({ ...FULL, audience: { segment: "x" } });
    expect(inAudience.ok).toBe(false);

    const inCondition = parseDefinition({
      ...FULL,
      steps: [{ key: "c", type: "condition", if: { has_tag: "x", extra: 1 }, then: "end", else: "end" }],
    });
    expect(inCondition.ok).toBe(false);

    const inOps = parseDefinition({ ...FULL, trigger: { event: "booking.confirmed", where: { "data.x": { like: "a" } } } });
    expect(inOps.ok).toBe(false);
  });

  it("rejects duplicate step keys, bad keys, empty and oversized step lists", () => {
    const dup = parseDefinition({ ...FULL, steps: [FULL.steps[0], FULL.steps[0]] });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.issues).toEqual([expect.objectContaining({ code: "duplicate_step_key", path: "steps.1.key" })]);
    expect(parseDefinition({ ...FULL, steps: [{ ...FULL.steps[0], key: "Bad-Key" }] }).ok).toBe(false);
    expect(parseDefinition({ ...FULL, steps: [] }).ok).toBe(false);
    const many = Array.from({ length: 41 }, (_, i) => ({ key: `s${i}`, type: "wait", minutes: 1 }));
    expect(parseDefinition({ ...FULL, steps: many }).ok).toBe(false);
  });

  it("checks anchors, re-entry, snap_to, exit_on strings and filter paths", () => {
    expect(parseDefinition({ ...FULL, anchor: "starts_at" }).ok).toBe(false);
    expect(parseDefinition({ ...FULL, anchor: "data." }).ok).toBe(false);
    expect(parseDefinition({ ...FULL, re_entry: "after_days:30" }).ok).toBe(true);
    expect(parseDefinition({ ...FULL, re_entry: "after_days:-1" }).ok).toBe(false);
    expect(parseDefinition({ ...FULL, re_entry: "after_days:1.5" }).ok).toBe(false);
    expect(parseDefinition({ ...FULL, re_entry: "sometimes" }).ok).toBe(false);
    expect(parseDefinition({ ...FULL, steps: [{ key: "a", type: "wait", minutes: 1, at: { from: "enrolment", minutes: 0, snap_to: "25:00" } }] }).ok).toBe(false);
    expect(parseDefinition({ ...FULL, exit_on: ["Order Paid"] }).ok).toBe(false);
    expect(parseDefinition({ ...FULL, trigger: { event: "booking.confirmed", where: { session_kind: "event" } } }).ok).toBe(false);
    expect(parseDefinition({ ...FULL, trigger: { event: [] } }).ok).toBe(false);
  });

  it("accepts the segment, manual and list triggers and the placeholder credit kind", () => {
    const seg = parseDefinition({ ...FULL, trigger: { segment_enter: "7f0c1e1c-6a77-4f0e-9a43-2f4b2f2f6f11" } });
    expect(seg.ok).toBe(true);
    expect(parseDefinition({ ...FULL, trigger: { manual: true } }).ok).toBe(true);
    expect(parseDefinition({ ...FULL, trigger: { manual: false } }).ok).toBe(false);
    const list = parseDefinition({ ...FULL, trigger: { event: ["webinar.attended", "webinar.watched"] } });
    expect(list.ok).toBe(true);
    const grant = parseDefinition({
      ...FULL,
      steps: [{ key: "e", type: "email", template: "x-y", unless: { has_other_active_grant: { credit_kind: "{{trigger.data.credit_kind}}" } } }],
    });
    expect(grant.ok).toBe(true);
    const badGrant = parseDefinition({
      ...FULL,
      steps: [{ key: "e", type: "email", template: "x-y", unless: { has_other_active_grant: { credit_kind: "{{trigger.data.kind}}" } } }],
    });
    expect(badGrant.ok).toBe(false);
  });

  it("triggerKinds and reEntryDays", () => {
    expect(triggerKinds({ event: "a.b" })).toEqual(["a.b"]);
    expect(triggerKinds({ event: ["a.b", "c.d"] })).toEqual(["a.b", "c.d"]);
    expect(triggerKinds({ segment_enter: "x" })).toEqual(["segment.entered"]);
    expect(triggerKinds({ manual: true })).toEqual([]);
    expect(reEntryDays("after_days:30")).toBe(30);
    expect(reEntryDays("never")).toBeNull();
  });
});

describe("diffDefinitions and canonicalJson", () => {
  it("canonical JSON sorts keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson(undefined)).toBe("null");
  });

  it("reports top-level changes and step changes by key", () => {
    const next: Definition = {
      ...FULL,
      re_entry: "never",
      audience: { status: ["lead"] },
      subject: undefined,
      steps: [
        { ...FULL.steps[1]!, at: { from: "anchor", minutes: -2880 } },
        FULL.steps[0]!,
        { key: "new_step", type: "tag", tag: "x" },
      ],
    };
    const changes = diffDefinitions(FULL, next);
    const byPath = Object.fromEntries(changes.map((c) => [`${c.kind}:${c.path}`, c]));
    expect(byPath["changed:re_entry"]).toMatchObject({ before: "always", after: "never" });
    expect(byPath["removed:subject"]).toMatchObject({ before: "ref" });
    expect(byPath["removed:audience.locales"]).toBeDefined();
    expect(byPath["changed:steps.reminder_3d.at.minutes"]).toMatchObject({ before: -4320, after: -2880 });
    expect(byPath["removed:steps.reminder_3d.at.snap_to"]).toBeDefined();
    expect(byPath["moved:steps.reminder_3d"]).toMatchObject({ before: 1, after: 0 });
    expect(byPath["added:steps.new_step"]).toBeDefined();
    expect(byPath["removed:steps.check"]).toBeDefined();
    expect(byPath["added:audience"]).toBeUndefined();
    expect(diffDefinitions(FULL, JSON.parse(JSON.stringify(FULL)) as Definition)).toEqual([]);
  });

  it("an added top-level field is reported", () => {
    const { subject: _s, ...withoutSubject } = FULL;
    expect(diffDefinitions(withoutSubject, FULL)).toEqual([{ path: "subject", kind: "added", after: "ref" }]);
  });
});
