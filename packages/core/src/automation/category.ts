/**
 * The category of an automation for the list screen (owner's review, section 10: "categorise
 * automations to make them easier to navigate"). Derived from the trigger, so it needs no stored
 * field and follows the definition when the trigger changes. Pure.
 */
export const AUTOMATION_CATEGORIES = ["bookings", "packages", "memberships", "leads", "reengagement", "transactional", "other"] as const;
export type AutomationCategory = (typeof AUTOMATION_CATEGORIES)[number];

/** Event kind prefixes per category; the first match wins. */
const PREFIXES: readonly (readonly [AutomationCategory, readonly string[]])[] = [
  ["reengagement", ["person.inactive_days"]],
  ["bookings", ["booking.", "waitlist.", "session."]],
  ["packages", ["credits.", "package."]],
  ["memberships", ["membership."]],
  ["leads", ["webinar.", "person.created", "assessment.", "opportunity.", "ops.stage_changed", "form."]],
  ["transactional", ["checkout.", "order.", "invoice.", "payment.", "voucher."]],
];

/** The category of a trigger (a published or draft definition's `trigger`, any shape). */
export function automationCategory(trigger: unknown): AutomationCategory {
  if (!trigger || typeof trigger !== "object") return "other";
  const t = trigger as { event?: unknown; segment_enter?: unknown };
  if (typeof t.segment_enter === "string") return "reengagement";
  const kinds = ([] as unknown[]).concat(t.event ?? []).filter((k): k is string => typeof k === "string");
  for (const [category, prefixes] of PREFIXES) if (kinds.some((k) => prefixes.some((p) => k.startsWith(p)))) return category;
  return "other";
}
