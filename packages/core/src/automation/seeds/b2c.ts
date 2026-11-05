/**
 * The B2C playbook automations of spec 3.7 (A-42, A-43; blueprint 20 and 29; automation-P8):
 * one seeded journey per pipeline stage, triggered by ops' `ops.stage_changed` where `data.to`
 * is that stage. The stage itself is computed by `ops` (`person_stats.b2c_stage`), never typed;
 * these journeys only carry out the stage's required action (a task for the responsible role,
 * a tag, or ending the journeys a member no longer needs) and its escalation.
 *
 * All are R2 drafts in the non-exclusive `sales` group (task-only, `is_marketing = false`), so a
 * playbook task is created whatever sales journey blocks the exclusive lane, and
 * `activateReleaseSequences(tx, 'R2')` switches them on. `first_visit` has no playbook journey
 * (`after-first-visit` handles it); `lead` and `active` have none in A-43.
 *
 * Escalation: a `notify_slack` step after N days, skipped unless the step's own task is still
 * open (`unless: { not: { task_open } }`). A journey ends when the person leaves its stage
 * (`ops.stage_changed` with `data.from = <stage>`), so a stale escalation never fires.
 *
 * Decisions: re-entry `after_days:30` (ops dedupes a stage change once per stage per day; a
 * person flipping between two stages gets one task per stage per month); task due dates are the
 * A-43 deadlines; titles are Dutch like the other seeded tasks (BEAM edits them).
 */
import type { Filter, Step } from "../definition";
import { DAY, definition, fromEnrolment, type SeedAutomation, type SeedTag } from "./groups";

/** The stages of `ops` (`B2C_STAGES`) that have a playbook journey (A-43). */
export const B2C_PLAYBOOK_STAGES = ["engaged_lead", "experienced", "first_purchase", "repeat", "member", "retention", "lost"] as const;
export type B2cPlaybookStage = (typeof B2C_PLAYBOOK_STAGES)[number];

/** The slug of a stage's playbook journey (`b2c-engaged-lead`). */
export const b2cPlaybookSlug = (stage: B2cPlaybookStage): string => `b2c-${stage.replaceAll("_", "-")}`;

/** Tags the playbook applies, besides the module's `SEED_TAGS` (inserted when absent, never changed). */
export const B2C_TAGS: SeedTag[] = [
  { key: "repeat", name: { "nl-BE": "Terugkerend", "fr-BE": "Fidèle", en: "Repeat customer" }, color: "#0891b2", description: "Reached the B2C stage repeat (ops)." },
  { key: "lost", name: { "nl-BE": "Verloren", "fr-BE": "Perdu", en: "Lost" }, color: "#9ca3af", description: "Reached the B2C stage lost (ops)." },
];

const stageTrigger = (stage: B2cPlaybookStage): { event: string; where: Filter } => ({ event: "ops.stage_changed", where: { "data.to": stage } });
const leftStage = (stage: B2cPlaybookStage) => ({ event: "ops.stage_changed", where: { "data.from": stage } });

type Playbook = { stage: B2cPlaybookStage; name: string; description: string; steps: Step[]; exitOnLeave?: boolean };

function playbook(p: Playbook): SeedAutomation {
  return {
    slug: b2cPlaybookSlug(p.stage),
    name: p.name,
    description: p.description,
    groupKey: "sales",
    priority: 100,
    isMarketing: false,
    purpose: null,
    status: "draft",
    requiresDpia: null,
    requiresFlag: null,
    release: "R2",
    definition: definition({
      trigger: stageTrigger(p.stage),
      anchor: "enrolment",
      re_entry: "after_days:30",
      exit_on: p.exitOnLeave === false ? [] : [leftStage(p.stage)],
      steps: p.steps,
    }),
    templates: [],
  };
}

/** A playbook task at +0 with the A-43 deadline. */
const task = (title: string, ownerRole: "sales" | "customer_service", dueDays: number, kind: "call" | "follow_up" = "follow_up"): Step => ({
  key: "task",
  type: "task",
  title,
  kind,
  owner_role: ownerRole,
  due_in_minutes: dueDays * DAY,
  priority: "normal",
  at: fromEnrolment(0),
});

/** The escalation of a still-open playbook task after `days`. */
const escalation = (days: number, text: string): Step => ({
  key: "escalate",
  type: "notify_slack",
  text,
  at: fromEnrolment(days * DAY),
  unless: { not: { task_open: "task" } },
});

export const B2C_SEEDS: SeedAutomation[] = [
  playbook({
    stage: "engaged_lead",
    name: "B2C playbook: engaged lead",
    description: "Invite an engaged lead to a BEAM Experience within 2 days; Slack escalation after 4 days while the task is open.",
    steps: [
      task("Nodig uit voor BEAM Experience", "sales", 2, "call"),
      escalation(4, "Playbook engaged lead: {{first_name}} wacht al 4 dagen op een uitnodiging voor een BEAM Experience ({{person_url}}, {{automation}})."),
    ],
  }),
  playbook({
    stage: "experienced",
    name: "B2C playbook: experienced",
    description: "Plan the first visit within 2 days after a BEAM Experience.",
    steps: [task("Plan eerste bezoek", "sales", 2, "call")],
  }),
  playbook({
    stage: "first_purchase",
    name: "B2C playbook: first purchase",
    description: "Welcome call within 3 days after the first purchase.",
    steps: [task("Welkomstgesprek", "customer_service", 3, "call")],
  }),
  playbook({
    stage: "repeat",
    name: "B2C playbook: repeat",
    description: "Tags a repeat customer.",
    steps: [{ key: "tag_repeat", type: "tag", tag: "repeat", at: fromEnrolment(0) }],
    exitOnLeave: false,
  }),
  playbook({
    stage: "member",
    name: "B2C playbook: member",
    description: "Ends the lead and first-visit journeys a new member no longer needs.",
    steps: [
      { key: "exit_welcome_lead", type: "exit", automation: "welcome-lead", at: fromEnrolment(0) },
      { key: "exit_after_first_visit", type: "exit", automation: "after-first-visit", at: fromEnrolment(0) },
    ],
    exitOnLeave: false,
  }),
  playbook({
    stage: "retention",
    name: "B2C playbook: retention",
    description: "Reactivation call within 2 days; Slack escalation after 5 days while the task is open.",
    steps: [
      task("Reactiveringscall", "customer_service", 2, "call"),
      escalation(5, "Playbook retentie: de reactiveringscall voor {{first_name}} staat al 5 dagen open ({{person_url}}, {{automation}})."),
    ],
  }),
  playbook({
    stage: "lost",
    name: "B2C playbook: lost",
    description: "Tags a lost customer.",
    steps: [{ key: "tag_lost", type: "tag", tag: "lost", at: fromEnrolment(0) }],
    exitOnLeave: false,
  }),
];
