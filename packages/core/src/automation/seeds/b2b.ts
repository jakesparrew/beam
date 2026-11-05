/**
 * The R3 B2B follow-up task journeys (automation spec 1 and 12, decision 35; automation-P9): one
 * seeded journey per opportunity stage that needs a follow-up, triggered by crm's
 * `opportunity.stage_changed` where `data.to_stage` is that stage. They create tasks and Slack
 * messages only: automated B2B outbound email is "Later" (spec 1), so no B2B journey has an
 * `email` step.
 *
 * - `b2b-qualified`: a discovery call task, due in 2 days.
 * - `b2b-proposal`: a follow-up task 5 days after the opportunity entered `proposal`, and a Slack
 *   escalation 10 days after it while that task is still open.
 * - `b2b-won`: an account-management task, due in 7 days.
 *
 * Every task goes to the opportunity owner (`owner: 'trigger_owner'`, `data.owner_user_id` of the
 * trigger) when that user is active staff, else to the least busy `sales` user (A-33).
 *
 * The enrolled person is the event's person (the opportunity's primary contact); `subject: 'ref'`
 * keeps one enrolment per opportunity, so a contact of two opportunities gets both follow-ups
 * (`re_entry: 'always'`; an active enrolment of the same opportunity still refuses a second one).
 * A journey ends when its opportunity leaves the stage (`opportunity.stage_changed` with
 * `data.from_stage = <stage>` for the same opportunity), so a moved or lost deal gets no stale
 * follow-up or escalation.
 *
 * All are R3 drafts in the non-exclusive `sales` group (`is_marketing = false`, no purpose: they
 * never send), with a published version 1, switched on by `activateReleaseSequences(tx, 'R3')`.
 *
 * Decisions: the proposal follow-up task is created at +5 days and due 2 days later, the
 * escalation fires at +10 days from the stage change; the qualified and won tasks are created at
 * once with the 2- and 7-day deadlines; titles are Dutch like the other seeded tasks (BEAM edits
 * them).
 */
import type { Filter, Step } from "../definition";
import { DAY, definition, fromEnrolment, type SeedAutomation, type SeedRelease } from "./groups";

/** The opportunity stages (`opportunities_stage`) that have a B2B follow-up journey. */
export const B2B_JOURNEY_STAGES = ["qualified", "proposal", "won"] as const;
export type B2bJourneyStage = (typeof B2B_JOURNEY_STAGES)[number];

/** The slug of a stage's B2B journey (`b2b-proposal`). */
export const b2bJourneySlug = (stage: B2bJourneyStage): string => `b2b-${stage}`;

/** The event crm records when an opportunity changes stage. */
export const OPPORTUNITY_STAGE_EVENT = "opportunity.stage_changed";

/**
 * R3. `SeedRelease` of `./groups` lists `V1` and `R2` only (requested: add `R3`); the activation
 * filter compares the release as a string, so the cast changes no behaviour.
 */
const R3 = "R3" as SeedRelease;

const stageTrigger = (stage: B2bJourneyStage): { event: string; where: Filter } => ({ event: OPPORTUNITY_STAGE_EVENT, where: { "data.to_stage": stage } });
const leftStage = (stage: B2bJourneyStage) => ({ event: OPPORTUNITY_STAGE_EVENT, where: { "data.from_stage": stage }, same_subject: true });

type Journey = { stage: B2bJourneyStage; name: string; description: string; steps: Step[] };

function journey(j: Journey): SeedAutomation {
  return {
    slug: b2bJourneySlug(j.stage),
    name: j.name,
    description: j.description,
    groupKey: "sales",
    priority: 100,
    isMarketing: false,
    purpose: null,
    status: "draft",
    requiresDpia: null,
    requiresFlag: null,
    release: R3,
    definition: definition({
      trigger: stageTrigger(j.stage),
      anchor: "enrolment",
      subject: "ref",
      re_entry: "always",
      exit_on: [leftStage(j.stage)],
      steps: j.steps,
    }),
    templates: [],
  };
}

/** A task for the opportunity owner (else sales), created `afterDays` after the stage change. */
const task = (key: string, title: string, kind: "call" | "follow_up", dueDays: number, afterDays = 0): Step => ({
  key,
  type: "task",
  title,
  kind,
  owner_role: "sales",
  owner: "trigger_owner",
  due_in_minutes: dueDays * DAY,
  priority: "normal",
  at: fromEnrolment(afterDays * DAY),
});

export const B2B_SEEDS: SeedAutomation[] = [
  journey({
    stage: "qualified",
    name: "B2B: qualified",
    description: "Discovery call task for the opportunity owner (else sales), due in 2 days.",
    steps: [task("discovery_call", "Plan een discovery call", "call", 2)],
  }),
  journey({
    stage: "proposal",
    name: "B2B: proposal follow-up",
    description: "Follow-up task 5 days after the proposal; Slack escalation after 10 days while the task is open.",
    steps: [
      task("follow_up", "Volg het voorstel op", "follow_up", 2, 5),
      {
        key: "escalate",
        type: "notify_slack",
        text: "B2B-voorstel: de opvolging bij {{first_name}} staat na 10 dagen nog open ({{person_url}}, {{automation}}).",
        at: fromEnrolment(10 * DAY),
        unless: { not: { task_open: "follow_up" } },
      },
    ],
  }),
  journey({
    stage: "won",
    name: "B2B: won",
    description: "Account-management task for the opportunity owner (else sales), due in 7 days.",
    steps: [task("account_management", "Start het accountbeheer: plan een kick-off met de klant", "follow_up", 7)],
  }),
];
