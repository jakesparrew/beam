import { describe, expect, it } from "vitest";
import type { Definition, Step } from "./definition";
import {
  DEFINITION_ISSUE_CODES,
  enrolTargets,
  isPublishable,
  referencedSegments,
  referencedTemplates,
  validateDefinition,
  type ValidationRefs,
} from "./validate";

const ALL = ["nl-BE", "fr-BE", "en"];
const refs = (over: Partial<ValidationRefs> = {}): ValidationRefs => ({
  automation: { slug: "welcome-lead", isMarketing: true, purpose: "newsletter", isExclusiveGroup: false },
  templates: {
    "welcome-lead-welcome": { kind: "marketing", purpose: "newsletter", locales: ALL },
    "event-invite": { kind: "marketing", purpose: "events", locales: ALL },
    "automation.event_reminder_7d": { kind: "transactional", purpose: null, locales: ["nl-BE", "en"] },
    "commerce.checkout_recovery": { kind: "transactional", purpose: null, locales: ALL },
  },
  automations: {
    "lead-sales-follow-up": { reEntry: "never", enrolTargets: [] },
    "ping-pong": { reEntry: "always", enrolTargets: ["welcome-lead"] },
    "ping-never": { reEntry: "never", enrolTargets: ["welcome-lead"] },
  },
  tags: ["engaged", "dormant"],
  roles: ["sales", "customer_service", "management"],
  webhookHosts: ["hooks.example.com"],
  ...over,
});

const def = (steps: Step[], over: Partial<Definition> = {}): Definition => ({
  schema_version: 1,
  trigger: { event: "person.created" },
  anchor: "enrolment",
  re_entry: "never",
  exit_on: [],
  steps,
  ...over,
});

const codes = (d: Definition, r: ValidationRefs = refs()) => validateDefinition(d, r).map((i) => i.code);
const email = (template = "welcome-lead-welcome"): Step => ({ key: "welcome", type: "email", template });

describe("validateDefinition (A-1, A-3, A-4)", () => {
  it("a valid definition has no issues", () => {
    const issues = validateDefinition(def([email(), { key: "tag_engaged", type: "tag", tag: "engaged" }]), refs());
    expect(issues).toEqual([]);
    expect(isPublishable(issues)).toBe(true);
  });

  it("trigger_history_imported for ops.history_imported alone and inside a trigger list", () => {
    expect(codes(def([email()], { trigger: { event: "ops.history_imported" } }))).toEqual(["trigger_history_imported"]);
    expect(codes(def([email()], { trigger: { event: ["person.created", "ops.history_imported"] } }))).toEqual(["trigger_history_imported"]);
  });

  it("trigger_automation_kind for automation.* kinds", () => {
    expect(codes(def([email()], { trigger: { event: "automation.entered" } }))).toEqual(["trigger_automation_kind"]);
  });

  it("branch_backward and branch_target_unknown (no loops)", () => {
    const steps: Step[] = [
      email(),
      { key: "check", type: "condition", if: { has_tag: "engaged" }, then: "welcome", else: "nope" },
      { key: "self", type: "condition", if: { has_tag: "engaged" }, then: "self", else: "end" },
    ];
    expect(codes(def(steps))).toEqual(["branch_backward", "branch_target_unknown", "branch_backward"]);
  });

  it("template_unavailable, template_purpose_mismatch and translation_missing", () => {
    expect(codes(def([email("missing-template")]))).toEqual(["template_unavailable"]);
    expect(codes(def([email("event-invite")]))).toEqual(["template_purpose_mismatch"]);
    const missing = validateDefinition(def([email("automation.event_reminder_7d")]), refs());
    expect(missing).toEqual([expect.objectContaining({ code: "translation_missing", params: { template: "automation.event_reminder_7d", locales: ["fr-BE"] } })]);
    expect(codes(def([email("automation.event_reminder_7d")], { audience: { locales: ["nl-BE", "en"] } }))).toEqual([]);
  });

  it("A-4: a null-purpose automation accepts any marketing template", () => {
    const r = refs({ automation: { slug: "after-first-visit", isMarketing: false, purpose: null, isExclusiveGroup: true } });
    expect(codes(def([email("event-invite")]), r)).toEqual([]);
  });

  it("send_as_not_marketing outside a marketing automation with a purpose", () => {
    const step: Step = { key: "remind", type: "email", template: "commerce.checkout_recovery", send_as: "marketing" };
    expect(codes(def([step]))).toEqual([]);
    const r = refs({ automation: { slug: "x", isMarketing: false, purpose: null, isExclusiveGroup: false } });
    expect(codes(def([step]), r)).toEqual(["send_as_not_marketing"]);
    expect(codes(def([{ ...step, template: "nope" }]), r)).toEqual(["send_as_not_marketing", "template_unavailable"]);
  });

  it("enrol_self, automation_unknown and enrol_cycle (edge case 17)", () => {
    expect(codes(def([{ key: "e", type: "enrol", automation: "welcome-lead" }]))).toEqual(["enrol_self"]);
    expect(codes(def([{ key: "e", type: "enrol", automation: "ghost" }]))).toEqual(["automation_unknown"]);
    expect(codes(def([{ key: "e", type: "enrol", automation: "ping-pong" }]))).toEqual(["enrol_cycle"]);
    expect(codes(def([{ key: "e", type: "enrol", automation: "ping-never" }]))).toEqual([]);
    expect(codes(def([{ key: "e", type: "enrol", automation: "lead-sales-follow-up" }]))).toEqual([]);
    expect(codes(def([{ key: "x", type: "exit", automation: "ghost" }]))).toEqual(["automation_unknown"]);
    expect(codes(def([{ key: "x", type: "exit" }, { key: "y", type: "exit", automation: "welcome-lead" }]))).toEqual([]);
  });

  it("tag_unknown for tag, untag and has_tag; role_unknown for tasks", () => {
    expect(codes(def([{ key: "t", type: "tag", tag: "vip" }]))).toEqual(["tag_unknown"]);
    expect(codes(def([{ key: "t", type: "untag", tag: "vip" }]))).toEqual(["tag_unknown"]);
    expect(codes(def([{ ...email(), unless: { not: { has_tag: "vip" } } }]))).toEqual(["tag_unknown"]);
    const task: Step = { key: "call", type: "task", title: "Call", kind: "call", owner_role: "intern", due_in_minutes: 0, priority: "normal" };
    expect(codes(def([task]))).toEqual(["role_unknown"]);
  });

  it("placeholder_not_allowed in Slack texts and task titles", () => {
    expect(codes(def([{ key: "s", type: "notify_slack", text: "{{first_name}} at {{person_url}} in {{automation}}" }]))).toEqual([]);
    expect(codes(def([{ key: "s", type: "notify_slack", text: "{{email}} joined" }]))).toEqual(["placeholder_not_allowed"]);
    const task = (title: string): Step => ({ key: "t", type: "task", title, kind: "call", owner_role: "sales", due_in_minutes: 0, priority: "high" });
    expect(codes(def([task("Webinar CTA clicked: {{trigger.data.cta_key}}")]))).toEqual([]);
    expect(codes(def([task("Call {{first_name}}")]))).toEqual(["placeholder_not_allowed"]);
  });

  it("webhook_not_https and webhook_host_not_allowed", () => {
    const hook = (url: string): Step => ({ key: "h", type: "webhook", url });
    expect(codes(def([hook("https://hooks.example.com/beam")]))).toEqual([]);
    expect(codes(def([hook("https://HOOKS.example.com/beam")]))).toEqual([]);
    expect(codes(def([hook("http://hooks.example.com/beam")]))).toEqual(["webhook_not_https"]);
    expect(codes(def([hook("https://user:pw@hooks.example.com/")]))).toEqual(["webhook_not_https"]);
    expect(codes(def([hook("not a url")]))).toEqual(["webhook_not_https"]);
    expect(codes(def([hook("https://evil.example.org/")]))).toEqual(["webhook_host_not_allowed"]);
  });

  it("anchor_required and exclusive_subject", () => {
    const step: Step = { key: "r", type: "email", template: "welcome-lead-welcome", at: { from: "anchor", minutes: -60 } };
    expect(codes(def([step]))).toEqual(["anchor_required"]);
    expect(codes(def([step], { anchor: "data.starts_at" }))).toEqual([]);
    const exclusive = refs({ automation: { slug: "welcome-lead", isMarketing: true, purpose: "newsletter", isExclusiveGroup: true } });
    expect(codes(def([email()], { subject: "ref" }), exclusive)).toEqual(["exclusive_subject"]);
    expect(codes(def([email()], { subject: "ref" }))).toEqual([]);
  });

  it("interpolation_not_allowed in the trigger filter and trigger conditions", () => {
    expect(codes(def([email()], { trigger: { event: "credits.granted", where: { "data.credit_kind": "{{trigger.data.credit_kind}}" } } }))).toEqual([
      "interpolation_not_allowed",
    ]);
    expect(codes(def([email()], { trigger: { event: "credits.granted", where: { "data.credit_kind": { in: ["{{trigger.data.x}}"] } } } }))).toEqual([
      "interpolation_not_allowed",
    ]);
    expect(codes(def([{ ...email(), unless: { trigger: { "data.credit_kind": { eq: "{{trigger.data.credit_kind}}" } } } }]))).toEqual([
      "interpolation_not_allowed",
    ]);
  });

  it("task_open and sent_within_days references", () => {
    expect(codes(def([{ ...email(), unless: { task_open: "missing" } }]))).toEqual(["branch_target_unknown"]);
    expect(codes(def([{ ...email(), unless: { sent_within_days: { template: "gone", days: 3 } } }]))).toEqual(["template_unavailable"]);
  });

  it("unknown_event_kind and unknown_event_path are warnings (edge case 22)", () => {
    const r = refs({ eventDataPaths: { "person.created": ["acquisition_source"], "order.paid": ["lines"] } });
    const d = def([email()], {
      trigger: { event: ["person.created", "webinar.new_kind"], where: { "data.acquisition_source": { nin: ["import"] }, "data.oops": 1, mode: "live" } },
      exit_on: [{ event: "order.paid", where: { "data.total": 1 } }, "booking.attended"],
    });
    const issues = validateDefinition(d, r);
    expect(issues.map((i) => [i.code, i.severity])).toEqual([
      ["unknown_event_path", "warning"],
      ["unknown_event_kind", "warning"],
      ["unknown_event_path", "warning"],
    ]);
    expect(isPublishable(issues)).toBe(true);
  });

  it("every code it can produce is in DEFINITION_ISSUE_CODES", () => {
    expect(new Set(DEFINITION_ISSUE_CODES).size).toBe(DEFINITION_ISSUE_CODES.length);
    expect(isPublishable([{ code: "tag_unknown", path: "", message: "", severity: "error" }])).toBe(false);
  });
});

describe("references", () => {
  const d = def(
    [
      { ...email(), unless: { any: [{ in_segment: "11111111-1111-4111-8111-111111111111" }, { sent_within_days: { template: "event-invite", days: 3 } }] } },
      { key: "c", type: "condition", if: { not: { in_segment: "22222222-2222-4222-8222-222222222222" } }, then: "end", else: "end" },
      { key: "e", type: "enrol", automation: "lead-sales-follow-up" },
      { key: "e2", type: "enrol", automation: "lead-sales-follow-up" },
    ],
    {
      trigger: { segment_enter: "33333333-3333-4333-8333-333333333333" },
      audience: { segment_id: "44444444-4444-4444-8444-444444444444", exclude_segment_ids: ["55555555-5555-4555-8555-555555555555"] },
    },
  );
  it("lists templates, segments and enrol targets", () => {
    expect(referencedTemplates(d)).toEqual(["event-invite", "welcome-lead-welcome"]);
    expect(referencedSegments(d)).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      "55555555-5555-4555-8555-555555555555",
    ]);
    expect(enrolTargets(d)).toEqual(["lead-sales-follow-up"]);
  });
});
