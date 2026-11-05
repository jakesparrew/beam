/**
 * Seeded automation groups (automation spec 2.2) and the building blocks every seed file uses:
 * the seed types, `at` helpers and the placeholder template builder (automation-P4).
 *
 * Templates are block-backed (`email.seedTemplate`): marketing slugs kebab-case, transactional
 * slugs `automation.<snake_name>` (cross-module D1). The copy is short placeholder text in the
 * three locales (subject, preheader, one heading, one text block, one CTA) that BEAM replaces
 * before go-live; the seed never overwrites an edited template (decision 38).
 */
import type { BlockDocument } from "../../email/blocks";
import type { SeedTemplateInput } from "../../email/types";
import type { LocalizedText } from "../../i18n/localized-text";
import type { At, AutomationPurpose, Condition, Definition } from "../definition";

export type SeedGroup = {
  key: string;
  name: string;
  description: string;
  isExclusive: boolean;
  /** Groups with the same lane share one exclusivity domain (`coalesce(lane, key)`). */
  lane: string | null;
  priority: number;
};

export type SeedRelease = "V1" | "R2" | "R3";

export type SeedAutomation = {
  slug: string;
  name: string;
  description: string;
  groupKey: string;
  /** Tie-breaker inside a domain after the group priority (lower wins). */
  priority: number;
  isMarketing: boolean;
  purpose: AutomationPurpose | null;
  /** V1 journeys are `active`; R2 journeys are `draft` with a published version (decision 30). */
  status: "active" | "draft";
  requiresDpia: "watch_time_profiling" | null;
  requiresFlag: "ff_commerce_checkout_recovery" | null;
  release: SeedRelease;
  definition: Definition;
  /** The block-backed templates this module seeds for the journey (owners' templates are not listed). */
  templates: SeedTemplateInput[];
};

/** Tags the seeded journeys apply or test (`tags.key`); inserted when absent, never changed. */
export type SeedTag = { key: string; name: Required<LocalizedText>; color: string; description: string };

/** Spec 2.2 seed (key, exclusive, lane, priority), plus the additions `review`, `sales`, `checkout`. */
export const SEED_GROUPS: SeedGroup[] = [
  { key: "customer_journey", name: "Customer journey", description: "First visit and conversion journeys of new customers.", isExclusive: true, lane: "sales_journey", priority: 10 },
  { key: "webinar", name: "Webinar", description: "Webinar behaviour follow-up (the deepest engagement wins).", isExclusive: true, lane: "sales_journey", priority: 20 },
  { key: "waitlist", name: "Waitlist", description: "Follow-up after a waitlist offer expired.", isExclusive: true, lane: "sales_journey", priority: 25 },
  { key: "lead_nurture", name: "Lead nurture", description: "Welcome and education journeys for new leads.", isExclusive: true, lane: "sales_journey", priority: 30 },
  { key: "package", name: "Packages", description: "Package usage, expiry and repurchase reminders.", isExclusive: false, lane: null, priority: 100 },
  { key: "inactivity", name: "Inactivity", description: "We-miss-you journeys after 30, 60, 90 and 180 days.", isExclusive: false, lane: null, priority: 100 },
  { key: "membership", name: "Membership", description: "Member welcome and renewal reminders.", isExclusive: false, lane: null, priority: 100 },
  { key: "transactional", name: "Transactional", description: "Service messages around bookings, events and the waitlist.", isExclusive: false, lane: null, priority: 100 },
  { key: "review", name: "Reviews", description: "Review requests after a visit.", isExclusive: false, lane: null, priority: 100 },
  { key: "sales", name: "Sales tasks", description: "Task-only journeys for the sales team.", isExclusive: false, lane: null, priority: 100 },
  { key: "checkout", name: "Checkout recovery", description: "Abandoned checkout reminders.", isExclusive: false, lane: null, priority: 100 },
];

export const SEED_TAGS: SeedTag[] = [
  { key: "engaged", name: { "nl-BE": "Betrokken", "fr-BE": "Engagé", en: "Engaged" }, color: "#16a34a", description: "Clicked a nurture email or watched a webinar; makes a lead an engaged lead." },
  { key: "package_nearly_used", name: { "nl-BE": "Pakket bijna op", "fr-BE": "Forfait presque épuisé", en: "Package nearly used" }, color: "#d97706", description: "80 % of a day or night package is used." },
  { key: "dormant", name: { "nl-BE": "Slapend", "fr-BE": "Inactif", en: "Dormant" }, color: "#64748b", description: "No visit for 180 days." },
  { key: "reviewed", name: { "nl-BE": "Review geschreven", "fr-BE": "Avis donné", en: "Reviewed" }, color: "#7c3aed", description: "Has left a review; no more review requests." },
];

// ---------------------------------------------------------------------------
// Time helpers (minutes in the definition)
// ---------------------------------------------------------------------------

export const HOUR = 60;
export const DAY = 1_440;

/** `+N min` from the enrolment, optionally snapped to a Brussels time of day. */
export const fromEnrolment = (minutes: number, snapTo?: string): At => (snapTo ? { from: "enrolment", minutes, snap_to: snapTo } : { from: "enrolment", minutes });
/** `N min` relative to the anchor (negative = before it). */
export const fromAnchor = (minutes: number, snapTo?: string): At => (snapTo ? { from: "anchor", minutes, snap_to: snapTo } : { from: "anchor", minutes });
/** `+N min` after the previous planned step. */
export const afterPrevious = (minutes: number): At => ({ from: "previous", minutes });

/** A condition that always ends the journey (closes a branch of a `condition` chain). */
export const endBranch = (key: string) => ({ key, type: "condition" as const, if: { all: [] } as Condition, then: "end", else: "end" });

/** The definition skeleton every seed shares. */
export function definition(d: Omit<Definition, "schema_version">): Definition {
  return { schema_version: 1, ...d };
}

// ---------------------------------------------------------------------------
// Placeholder templates
// ---------------------------------------------------------------------------

type Copy = { subject: string; preheader: string; heading: string; text: string; cta: string };
export type TemplateCopy = { "nl-BE": Copy; "fr-BE": Copy; en: Copy };

const LOCALES = ["nl-BE", "fr-BE", "en"] as const;
const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A stable 10-character block id from a seed string (FNV-1a), so reseeding yields equal documents. */
export function seedBlockId(seed: string): string {
  let h = 0x811c9dc5;
  let out = "";
  for (let round = 0; out.length < 10; round++) {
    for (const ch of `${seed}#${round}`) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    let x = h;
    for (let i = 0; i < 5 && out.length < 10; i++) {
      out += ID_ALPHABET[x % ID_ALPHABET.length];
      x = Math.floor(x / ID_ALPHABET.length);
    }
  }
  return out;
}

/** The public site path a CTA opens (`https://beam.be/<locale><path>`). */
const href = (locale: string, path: string) => `https://beam.be/${locale}${path}`;

/**
 * A block-backed template with a published version 1 in all three locales: heading, text and a
 * primary button per locale.
 */
export function seedTemplate(input: {
  slug: string;
  name: string;
  kind: "transactional" | "marketing";
  purpose?: AutomationPurpose | null;
  /** Site path of the CTA, without the locale (`/booking`). */
  path: string;
  copy: TemplateCopy;
}): SeedTemplateInput {
  const subject: LocalizedText = {};
  const preheader: LocalizedText = {};
  const locales: BlockDocument["locales"] = {};
  for (const l of LOCALES) {
    const c = input.copy[l];
    subject[l] = c.subject;
    preheader[l] = c.preheader;
    locales[l] = [
      { id: seedBlockId(`${input.slug}:${l}:heading`), type: "heading", level: 1, text: c.heading },
      { id: seedBlockId(`${input.slug}:${l}:text`), type: "text", markdown: c.text },
      { id: seedBlockId(`${input.slug}:${l}:cta`), type: "button", label: c.cta, href: href(l, input.path), style: "primary" },
    ];
  }
  return {
    slug: input.slug,
    name: input.name,
    kind: input.kind,
    purpose: input.kind === "marketing" ? (input.purpose ?? "newsletter") : null,
    subject,
    preheader,
    document: { schemaVersion: 1, locales },
  };
}

/** Shorthand for the copy of one locale. */
export const c = (subject: string, preheader: string, heading: string, text: string, cta: string): Copy => ({ subject, preheader, heading, text, cta });
