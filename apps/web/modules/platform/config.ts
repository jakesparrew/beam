/**
 * Platform settings and flags (platform spec section 2 "Platform keys"). Facade read by
 * `pnpm gen:indexes`: every `key` is a literal. Fields inside values are snake_case.
 */
import { z } from "zod";
import { AiPricingSchema, DEFAULT_AI_PRICING } from "@beam/core/ai";
import { emptyGoLiveGate, GO_LIVE_ITEMS } from "@beam/core/platform";
import { defineSetting } from "@/lib/settings";

const hm = z.string().regex(/^\d{2}:\d{2}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const AiSetting = z.object({
  sensitive_enabled: z.boolean(),
  purpose: z.string().nullable(),
  dpia_reference: z.string().nullable(),
  enabled_by_user_id: z.string().uuid().nullable(),
  enabled_at: z.string().nullable(),
  monthly_budget_cents: z.number().int().nonnegative(),
  daily_cap_calls: z.number().int().nonnegative(),
  pricing: AiPricingSchema,
});

export const CompanySetting = z.object({
  legal_name: z.string().min(1),
  trade_name: z.string().min(1),
  vat_number: z.string().regex(/^BE\d{10}$/),
  enterprise_number: z.string(),
  address: z.object({ street: z.string(), postal_code: z.string(), city: z.string(), country: z.literal("BE") }),
  support_email: z.string().email(),
  phone: z.string(),
  website: z.string(),
});

const GateItem = z.object({ confirmed_by_user_id: z.string().uuid().nullable(), confirmed_at: z.string().nullable(), note: z.string().nullable() });
export const GoLiveGateSetting = z.object({
  items: z.partialRecord(z.enum(GO_LIVE_ITEMS), GateItem.nullable()),
});

export const SecuritySetting = z.object({
  current_key_version: z.number().int().min(1),
  staff_idle_hours: z.number().positive(),
  staff_idle_hours_by_role: z.record(z.string(), z.number().positive()),
  staff_absolute_days: z.number().positive(),
  customer_session_days: z.number().positive(),
  lockout_threshold: z.number().int().positive(),
  lockout_minutes: z.number().int().positive(),
  last_backup_at: z.string().nullable(),
  last_backup_ok: z.boolean().nullable(),
  last_restore_drill_at: z.string().nullable(),
  last_restore_drill_ok: z.boolean().nullable(),
  last_pentest_on: isoDate.nullable(),
  next_pentest_due_on: isoDate.nullable(),
});

export const SupportSetting = z.object({
  business_hours: z.object({ weekday: z.tuple([hm, hm]), weekend_critical: z.tuple([hm, hm]) }),
  response_minutes: z.object({
    critical_business: z.number().int().positive(),
    critical_weekend: z.number().int().positive(),
    high: z.number().int().positive(),
    normal: z.number().int().positive(),
    improvement: z.number().int().positive(),
  }),
  emergency_phone: z.string(),
  support_email: z.string(),
  report_recipients: z.array(z.string().email()),
});

export const settings = [
  defineSetting({
    key: "ai",
    schema: AiSetting,
    default: {
      sensitive_enabled: false,
      purpose: null,
      dpia_reference: null,
      enabled_by_user_id: null,
      enabled_at: null,
      monthly_budget_cents: 10_000,
      daily_cap_calls: 500,
      pricing: { ...DEFAULT_AI_PRICING },
    },
    description: "AI gateway: sensitive processing switch, monthly budget, daily cap and model prices",
  }),
  defineSetting({
    key: "last_tick_at",
    schema: z.string().nullable(),
    default: null,
    isSystem: true,
    description: "When the one-minute tick last finished (system key)",
  }),
  defineSetting({
    key: "company",
    schema: CompanySetting,
    default: {
      legal_name: "Vibrant Lifestyle Collective BV",
      trade_name: "BEAM Vitality Center",
      vat_number: "BE0000000000",
      enterprise_number: "0000.000.000",
      address: { street: "", postal_code: "", city: "", country: "BE" },
      support_email: "support@demo.beam.be",
      phone: "",
      website: "",
    },
    description: "Issuer identity used by finance and the site contact block",
  }),
  defineSetting({
    key: "go_live_gate",
    schema: GoLiveGateSetting,
    default: emptyGoLiveGate() as z.infer<typeof GoLiveGateSetting>,
    description: "The 13 go-live items of blueprint 77",
  }),
  defineSetting({
    key: "security",
    schema: SecuritySetting,
    default: {
      current_key_version: 1,
      staff_idle_hours: 12,
      staff_idle_hours_by_role: { reception: 4 },
      staff_absolute_days: 7,
      customer_session_days: 90,
      lockout_threshold: 10,
      lockout_minutes: 15,
      last_backup_at: null,
      last_backup_ok: null,
      last_restore_drill_at: null,
      last_restore_drill_ok: null,
      last_pentest_on: null,
      next_pentest_due_on: null,
    },
    description: "Key version, session timeouts, lockout, backup and pentest status",
  }),
  defineSetting({
    key: "support",
    schema: SupportSetting,
    default: {
      business_hours: { weekday: ["09:00", "18:00"], weekend_critical: ["10:00", "18:00"] },
      response_minutes: { critical_business: 120, critical_weekend: 240, high: 240, normal: 540, improvement: 1080 },
      emergency_phone: "",
      support_email: "support@demo.beam.be",
      report_recipients: [],
    },
    description: "Support hours, response targets (PL-88), emergency phone and report recipients",
  }),
] as const;

export const flags = [] as const;
