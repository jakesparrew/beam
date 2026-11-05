"use server";
/**
 * Pipeline and playbook actions (crm spec 4.2), crm-P8. `saveOpportunity` and
 * `moveOpportunityStage` need `crm.b2b`; `savePlaybookStage` needs `settings.write`. The
 * handlers in `./api` write their own audit rows (`opportunity.save`, `opportunity.stage`,
 * `playbook.save`), so the wrapper's row is off. Only async functions are exported (OD-18).
 */
import { z } from "zod";
import { OPPORTUNITY_STAGES, ROLE_KEYS } from "@beam/db/schema";
import { LocalizedTextSchema } from "@beam/core/i18n";
import { action } from "@/lib/action";
import { moveStaffOpportunity, saveStaffOpportunity, saveStaffPlaybookStage } from "./api";

export const saveOpportunity = action(
  {
    name: "crm.save_opportunity",
    audience: "staff",
    permission: "crm.b2b",
    input: z.object({
      id: z.uuid().optional(),
      companyId: z.uuid(),
      title: z.string().trim().min(1).max(200),
      primaryContactPersonId: z.uuid().nullable().optional(),
      valueCents: z.number().int().min(0).max(2_000_000_000),
      probabilityPct: z.number().int().min(0).max(100).optional(),
      expectedCloseOn: z.iso.date().nullable().optional(),
      ownerUserId: z.uuid(),
      nextAction: z.string().max(500).nullable().optional(),
      nextActionAt: z.coerce.date().nullable().optional(),
      notes: z.string().max(5000).nullable().optional(),
      source: z.string().max(200).nullable().optional(),
      version: z.number().int().positive().optional(),
    }),
    audit: false,
  },
  (ctx, input) => saveStaffOpportunity(ctx, input),
);

export const moveOpportunityStage = action(
  {
    name: "crm.move_opportunity",
    audience: "staff",
    permission: "crm.b2b",
    input: z.object({ id: z.uuid(), stage: z.enum(OPPORTUNITY_STAGES), version: z.number().int().positive(), lostReason: z.string().max(500).optional() }),
    audit: false,
  },
  (ctx, input) => moveStaffOpportunity(ctx, input),
);

const PlaybookText = LocalizedTextSchema;

export const savePlaybookStage = action(
  {
    name: "crm.save_playbook_stage",
    audience: "staff",
    permission: "settings.write",
    input: z.object({
      pipeline: z.enum(["b2b", "b2c"]),
      stageKey: z.string().min(1).max(64),
      sortOrder: z.number().int().min(0).max(32767),
      name: PlaybookText,
      requiredAction: PlaybookText,
      ownerRole: z.enum(ROLE_KEYS),
      deadlineDays: z.number().int().min(0).max(365),
      defaultProbabilityPct: z.number().int().min(0).max(100).nullable().optional(),
      automatedCommunication: z.object({ automation_slug: z.string().max(100).optional(), template_slug: z.string().max(100).optional() }).strict(),
      humanCommunication: PlaybookText.nullable().optional(),
      escalation: z.object({ after_days: z.number().int().min(0).max(365).optional(), notify_role: z.enum(ROLE_KEYS).optional(), create_task: z.boolean().optional() }).strict(),
      kpi: z
        .object({ name: PlaybookText.optional(), target: z.number().min(0).max(1_000_000_000).optional(), unit: z.enum(["count", "pct", "cents", "days"]).optional() })
        .strict(),
      isActive: z.boolean(),
    }),
    audit: false,
  },
  (ctx, input) => saveStaffPlaybookStage(ctx, input),
);
