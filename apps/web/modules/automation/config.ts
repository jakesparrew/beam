/**
 * automation settings (automation spec 4.5, 02-data-model 5.4). Facade read by `pnpm gen:indexes`.
 *
 * - `automation_cursor` is a system key (`SYSTEM_SETTING_KEYS`): written by `automation.evaluate`
 *   only, without a version bump or audit row. It holds the last processed `activity_events.id`
 *   and the gap ids below it that were not visible yet (A-8, edge case 2).
 * - `automation_rules` holds the frequency caps, quiet hours (R2, automation-P7) and the webhook
 *   host allow-list. It is edited on `/admin/automations/rules` (`updateAutomationRules`,
 *   `automations.publish`; changing the webhook hosts also needs `settings.write`), linked from
 *   the automations list.
 */
import { z } from "zod";
import { defineSetting } from "@/lib/settings";

const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const EVENT_ID = /^\d{1,19}$/;

/** One id below the cursor that was missing when a later id was processed. */
export const CursorGap = z.object({ id: z.string().regex(EVENT_ID), first_seen_at: z.iso.datetime({ offset: true }) });

export const AutomationCursor = z.object({
  last_event_id: z.string().regex(EVENT_ID),
  gaps: z.array(CursorGap).max(5_000),
});
export type AutomationCursorValue = z.infer<typeof AutomationCursor>;

export const AutomationRules = z.object({
  max_marketing_per_day: z.number().int().min(0).max(10),
  max_marketing_per_week: z.number().int().min(0).max(30),
  quiet_start: z.string().regex(HHMM),
  quiet_end: z.string().regex(HHMM),
  webhook_hosts: z.array(z.string().min(1).max(253).regex(/^[a-z0-9.-]+$/)).max(50),
});
export type AutomationRulesValue = z.infer<typeof AutomationRules>;

export const DEFAULT_AUTOMATION_RULES: AutomationRulesValue = {
  max_marketing_per_day: 1,
  max_marketing_per_week: 3,
  quiet_start: "21:00",
  quiet_end: "08:00",
  webhook_hosts: [],
};

export const settings = [
  defineSetting({
    key: "automation_cursor",
    schema: AutomationCursor,
    default: { last_event_id: "0", gaps: [] },
    isSystem: true,
    description: "The last activity_events id processed by automation.evaluate and the gap ids below it (system key)",
  }),
  defineSetting({
    key: "automation_rules",
    schema: AutomationRules,
    default: DEFAULT_AUTOMATION_RULES,
    description: "Automation frequency caps, quiet hours (Europe/Brussels) and the allowed webhook hosts",
  }),
] as const;

export const flags = [] as const;
