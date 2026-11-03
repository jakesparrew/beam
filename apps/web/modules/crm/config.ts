/**
 * crm settings and flags (02-data-model 5.4 and 5.5). Facade read by `pnpm gen:indexes`.
 * Wave 0 by platform-P7; crm owns it from crm-P1 on.
 */
import { z } from "zod";
import { defineSetting } from "@/lib/settings";

export const InboxSettings = z.object({
  escalation_hours: z.number().int().positive(),
  stale_pending_days: z.number().int().positive(),
  default_assignee_role: z.string(),
  meta_enabled: z.boolean(),
});

export const settings = [
  defineSetting({
    key: "inbox",
    schema: InboxSettings,
    default: { escalation_hours: 24, stale_pending_days: 14, default_assignee_role: "customer_service", meta_enabled: false },
    description: "Unified inbox escalation, stale threads, default assignee and the Meta switch (R3)",
  }),
] as const;

export const flags = [
  { key: "ff_crm_pipeline", description: "B2B pipeline navigation and screens (R3)" },
  { key: "ff_crm_inbox", description: "Unified inbox (R3)" },
  { key: "ff_crm_inbox_meta", description: "Instagram and Messenger channels in the inbox (R3)" },
] as const;
