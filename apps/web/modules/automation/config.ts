/**
 * automation settings (02-data-model 5.4). Facade read by `pnpm gen:indexes`. Wave 0 by
 * platform-P7; automation owns it from automation-P1 on. `automation_cursor` is a system key
 * (`SYSTEM_SETTING_KEYS`): written by the evaluator without a version bump or audit row.
 */
import { z } from "zod";
import { defineSetting } from "@/lib/settings";

export const settings = [
  defineSetting({
    key: "automation_cursor",
    schema: z.string().nullable(),
    default: null,
    isSystem: true,
    description: "The last activity_events id processed by automation.evaluate (system key)",
  }),
  defineSetting({
    key: "automation_rules",
    schema: z.record(z.string(), z.unknown()),
    default: {},
    description: "Conflict rules, quiet hours and allowed webhook hosts (R2; placeholder schema)",
  }),
] as const;

export const flags = [] as const;
