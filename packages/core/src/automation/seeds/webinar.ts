/**
 * The eleven webinar journeys of cross-module D52 (spec 3.6; R2 drafts with a published version,
 * activated by automation-P8). Webinar seeds no journey and no transactional template: the steps
 * name webinar's code-backed registry templates `webinar.reminder` (variant `d7|d3|h3` from the
 * `stepKey`) and `webinar.replay_available`, and webinar's marketing seed `webinar-follow-up`
 * (purpose `events`). Ids reach the templates in `context`, never in `variables`.
 *
 * "DPIA" = `requires_dpia = 'watch_time_profiling'` (A-5a): the eight journeys acting on watch
 * thresholds, attendance or CTA clicks. Live journeys filter `mode = live` (scenario 5). Inside the
 * exclusive `webinar` group the deepest engagement wins by automation priority (A-15).
 */
import type { Filter, Step } from "../definition";
import { DAY, definition, fromAnchor, fromEnrolment, HOUR, type SeedAutomation } from "./groups";

export const WEBINAR_REMINDER_TEMPLATE = "webinar.reminder";
export const WEBINAR_REPLAY_TEMPLATE = "webinar.replay_available";
export const WEBINAR_FOLLOW_UP_TEMPLATE = "webinar-follow-up";

const live: Filter = { mode: "live" };
const followUp: Step = { key: "follow_up", type: "email", template: WEBINAR_FOLLOW_UP_TEMPLATE, at: fromEnrolment(HOUR) };

type Behaviour = { slug: string; name: string; description: string; priority: number; trigger: { event: string; where: Filter }; steps?: Step[] };

/** A DPIA-gated marketing journey in the exclusive `webinar` group that exits on a purchase. */
function behaviour(b: Behaviour): SeedAutomation {
  return {
    slug: b.slug,
    name: b.name,
    description: b.description,
    groupKey: "webinar",
    priority: b.priority,
    isMarketing: true,
    purpose: "events",
    status: "draft",
    requiresDpia: "watch_time_profiling",
    requiresFlag: null,
    release: "R2",
    definition: definition({ trigger: b.trigger, anchor: "enrolment", re_entry: "always", exit_on: ["order.paid"], steps: b.steps ?? [followUp] }),
    templates: [],
  };
}

const r2 = { status: "draft" as const, requiresFlag: null, release: "R2" as const, templates: [] };

export const WEBINAR_SEEDS: SeedAutomation[] = [
  {
    ...r2,
    slug: "webinar-registration",
    name: "Webinar registration",
    description: "Reminders 7 days, 3 days and 3 hours before a live webinar (webinar's access email is the confirmation).",
    groupKey: "transactional",
    priority: 100,
    isMarketing: false,
    purpose: null,
    requiresDpia: null,
    definition: definition({
      trigger: { event: "webinar.registered", where: live },
      anchor: "data.starts_at",
      subject: "ref",
      re_entry: "after_days:0",
      exit_on: [
        { event: "webinar.cancelled", same_subject: true },
        { event: "webinar.registration_cancelled", same_subject: true },
        { event: "webinar.rescheduled", same_subject: true },
      ],
      steps: [
        { key: "d7", type: "email", template: WEBINAR_REMINDER_TEMPLATE, at: fromAnchor(-10_080) },
        { key: "d3", type: "email", template: WEBINAR_REMINDER_TEMPLATE, at: fromAnchor(-4_320) },
        { key: "h3", type: "email", template: WEBINAR_REMINDER_TEMPLATE, at: fromAnchor(-180) },
      ],
    }),
  },
  {
    ...r2,
    slug: "webinar-no-show",
    name: "Webinar no-show",
    description: "Replay link one hour after a missed live webinar with a replay.",
    groupKey: "webinar",
    priority: 70,
    isMarketing: true,
    purpose: "events",
    requiresDpia: null,
    definition: definition({
      trigger: { event: "webinar.no_show", where: { "data.replay_available": true } },
      anchor: "enrolment",
      re_entry: "always",
      exit_on: ["webinar.attended"],
      steps: [{ key: "replay", type: "email", template: WEBINAR_REPLAY_TEMPLATE, at: fromEnrolment(HOUR) }],
    }),
  },
  {
    ...r2,
    slug: "webinar-poll-answer",
    name: "Webinar poll answer",
    description: "Adds the engagement tag when a person answers a webinar poll (the poll's own tag rules tag the answer).",
    groupKey: "sales",
    priority: 100,
    isMarketing: false,
    purpose: null,
    requiresDpia: null,
    definition: definition({
      trigger: { event: "webinar.poll_answered" },
      anchor: "enrolment",
      re_entry: "always",
      exit_on: [],
      steps: [{ key: "tag_engaged", type: "tag", tag: "engaged", at: fromEnrolment(0) }],
    }),
  },
  behaviour({
    slug: "webinar-watched-end",
    name: "Webinar watched to the end",
    description: "Offer one hour after watching a live webinar to the end, and a sales task.",
    priority: 10,
    trigger: { event: "webinar.watched", where: { "data.threshold": "end", mode: "live" } },
    steps: [
      followUp,
      { key: "sales_task", type: "task", title: "Webinar volledig bekeken: opvolgen", kind: "follow_up", owner_role: "sales", due_in_minutes: DAY, priority: "normal", at: fromEnrolment(DAY), unless: { has_future_booking: true } },
    ],
  }),
  behaviour({ slug: "webinar-cta-click", name: "Webinar CTA click", description: "Follow-up one hour after a CTA click in a live webinar.", priority: 15, trigger: { event: "webinar.cta_clicked", where: live } }),
  {
    ...r2,
    slug: "webinar-cta-sales-task",
    name: "Webinar CTA sales task",
    description: "One sales task per webinar registration when its CTA is clicked, in any mode.",
    groupKey: "sales",
    priority: 100,
    isMarketing: false,
    purpose: null,
    requiresDpia: "watch_time_profiling",
    definition: definition({
      trigger: { event: "webinar.cta_clicked" },
      anchor: "enrolment",
      subject: "ref",
      re_entry: "never",
      exit_on: [],
      steps: [
        {
          key: "sales_task",
          type: "task",
          title: "Webinar CTA clicked: {{trigger.data.cta_key}}",
          kind: "follow_up",
          owner_role: "sales",
          due_in_minutes: DAY,
          priority: "normal",
          at: fromEnrolment(0),
          unless: { has_future_booking: true },
        },
      ],
    }),
  },
  behaviour({
    slug: "webinar-watched-30",
    name: "Webinar watched 30 minutes",
    description: "BEAM Experience invitation one hour after watching 30 minutes or half of a live webinar.",
    priority: 20,
    trigger: { event: "webinar.watched", where: { "data.threshold": { in: ["30m", "50pct"] }, mode: "live" } },
  }),
  behaviour({
    slug: "webinar-watched-15",
    name: "Webinar watched 15 minutes",
    description: "Engagement tag and a follow-up one hour after watching 15 minutes of a live webinar.",
    priority: 40,
    trigger: { event: "webinar.watched", where: { "data.threshold": "15m", mode: "live" } },
    steps: [{ key: "tag_engaged", type: "tag", tag: "engaged", at: fromEnrolment(0) }, followUp],
  }),
  behaviour({ slug: "webinar-replay", name: "Webinar replay", description: "Follow-up one hour after watching a webinar replay.", priority: 50, trigger: { event: "webinar.attended", where: { mode: "replay" } } }),
  behaviour({ slug: "webinar-on-demand", name: "Webinar on demand", description: "Follow-up one hour after watching an on-demand webinar.", priority: 55, trigger: { event: "webinar.attended", where: { mode: "on_demand" } } }),
  behaviour({ slug: "webinar-attended", name: "Webinar attended", description: "Follow-up one hour after attending a live webinar.", priority: 60, trigger: { event: "webinar.attended", where: live } }),
];
