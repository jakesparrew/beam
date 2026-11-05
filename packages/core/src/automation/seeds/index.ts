/**
 * `@beam/core/automation/seeds`: the seeded groups, tags and journeys of automation spec 3.6
 * (automation-P4). Pure data: `packages/db/src/seed/automation.ts` writes them (a slug is
 * inserted only when absent, so an edited or deactivated journey is never touched) and
 * `seedAutomation(tx)` in `apps/web/modules/automation/engine/seed-automations.ts` runs the same
 * writer with email's `seedTemplate`.
 *
 * V1 journeys are `active`; R2 journeys (webinar, `abandoned-checkout`, `waitlist-follow-up`,
 * `event-follow-up` and the B2C pipeline playbook of 3.7, automation-P8) are `draft` with a
 * published version 1 (decision 30), switched on by `activateReleaseSequences(tx, 'R2')` of
 * `@beam/db/seed/automation`. R3 journeys (the B2B follow-up tasks of automation-P9) are drafts the
 * same way, switched on by `activateReleaseSequences(tx, 'R3')`.
 */
import type { SeedTemplateInput } from "../../email/types";
import { ASSESSMENT_SEEDS } from "./assessment";
import { B2B_SEEDS } from "./b2b";
import { B2C_SEEDS, B2C_TAGS } from "./b2c";
import { BOOKING_SEEDS } from "./booking";
import { CHECKOUT_SEEDS } from "./checkout";
import { CUSTOMER_SEEDS } from "./customer";
import { EVENT_SEEDS } from "./events";
import { SEED_TAGS as JOURNEY_TAGS, type SeedAutomation, type SeedTag } from "./groups";
import { INACTIVITY_SEEDS } from "./inactivity";
import { LEAD_SEEDS } from "./lead";
import { MEMBERSHIP_SEEDS } from "./membership";
import { PACKAGE_SEEDS } from "./package";
import { REVIEW_SEEDS } from "./review";
import { WAITLIST_SEEDS } from "./waitlist";
import { WEBINAR_SEEDS } from "./webinar";

export {
  SEED_GROUPS,
  seedBlockId,
  type SeedAutomation,
  type SeedGroup,
  type SeedRelease,
  type SeedTag,
  type TemplateCopy,
} from "./groups";
export type { SeedTemplateInput } from "../../email/types";
export { B2B_JOURNEY_STAGES, b2bJourneySlug, OPPORTUNITY_STAGE_EVENT, type B2bJourneyStage } from "./b2b";
export { B2C_PLAYBOOK_STAGES, B2C_TAGS, b2cPlaybookSlug, type B2cPlaybookStage } from "./b2c";
export { HEALTH_DECLARATION_SLUG } from "./booking";
export { CHECKOUT_RECOVERY_TEMPLATE, HIGH_VALUE_CENTS } from "./checkout";
export { NEW_LEAD_FILTER } from "./lead";
export { WEBINAR_FOLLOW_UP_TEMPLATE, WEBINAR_REMINDER_TEMPLATE, WEBINAR_REPLAY_TEMPLATE } from "./webinar";

/** Every seeded journey, V1 first, in the order of spec 3.6, then R2 and the R3 B2B journeys. */
export const SEED_AUTOMATIONS: SeedAutomation[] = [
  ...LEAD_SEEDS,
  ...ASSESSMENT_SEEDS,
  ...EVENT_SEEDS.filter((s) => s.release === "V1"),
  ...BOOKING_SEEDS,
  ...CUSTOMER_SEEDS,
  ...PACKAGE_SEEDS,
  ...INACTIVITY_SEEDS,
  ...MEMBERSHIP_SEEDS,
  ...REVIEW_SEEDS,
  ...WAITLIST_SEEDS.filter((s) => s.release === "V1"),
  ...CHECKOUT_SEEDS,
  ...WAITLIST_SEEDS.filter((s) => s.release === "R2"),
  ...EVENT_SEEDS.filter((s) => s.release === "R2"),
  ...WEBINAR_SEEDS,
  ...B2C_SEEDS,
  ...B2B_SEEDS,
];

/** Every tag a seeded journey applies or tests: the journey tags and the playbook's `repeat` and `lost`. */
export const SEED_TAGS: SeedTag[] = [...JOURNEY_TAGS, ...B2C_TAGS.filter((t) => !JOURNEY_TAGS.some((j) => j.key === t.key))];

/** A release whose seeded drafts `activateReleaseSequences` switches on. */
export type ActivationRelease = "R2" | "R3";

/** The seeds of one release (R3 is automation-P9's B2B task journeys). */
export const seedsOfRelease = (release: ActivationRelease, seeds: readonly SeedAutomation[] = SEED_AUTOMATIONS): SeedAutomation[] =>
  seeds.filter((s) => s.release === release);

/**
 * Templates other modules seed that R2 drafts reference (webinar's registry templates and
 * marketing seed, commerce's registry template). Validation accepts them as missing while the
 * owner's seed is absent (automation-P4 dependencies).
 */
export const EXTERNAL_SEED_TEMPLATES = ["commerce.checkout_recovery", "webinar.reminder", "webinar.replay_available", "webinar-follow-up"] as const;

/** Every template this module seeds, once per slug, in journey order. */
export function seedTemplates(seeds: readonly SeedAutomation[] = SEED_AUTOMATIONS): SeedTemplateInput[] {
  const out = new Map<string, SeedTemplateInput>();
  for (const s of seeds) for (const t of s.templates) if (!out.has(t.slug)) out.set(t.slug, t);
  return [...out.values()];
}

/** The seed of one slug, or undefined. */
export const seedAutomationBySlug = (slug: string): SeedAutomation | undefined => SEED_AUTOMATIONS.find((s) => s.slug === slug);
