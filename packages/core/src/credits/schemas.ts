/**
 * credits Zod schemas: the `credits` setting (rule 6a), the grant sharing json and the inputs of
 * the V1 staff actions and of `grantCredits` (credits spec section 4). Every field the setting
 * stores is snake_case (Convention 3); action inputs are camelCase.
 */
import { z } from "zod";
import { completeLocalizedText, LocalizedTextSchema } from "../i18n/localized-text";

const uuid = () => z.string().uuid();
const reason = () => z.string().trim().min(3).max(500);
const dateOn = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const CREDIT_KINDS = ["day", "night", "euro"] as const;
export const GRANT_SOURCES = ["purchase", "voucher", "membership", "bonus", "import", "manual", "referral", "transfer"] as const;
export const VAT_RATES = [0, 6, 12, 21] as const;
export const PLAN_BENEFIT_KINDS = ["included_units", "discount", "member_only_access", "event_access", "event_discount", "other"] as const;

export const CreditKindSchema = z.enum(CREDIT_KINDS);
export const GrantSourceSchema = z.enum(GRANT_SOURCES);

// ---------------------------------------------------------------------------
// Setting `credits` (rule 6a)
// ---------------------------------------------------------------------------

const pctList = z.array(z.number().int().min(1).max(100)).min(1).max(10);
const dayList = z.array(z.number().int().min(1).max(366)).max(10);

export const CREDITS_SETTINGS_DEFAULTS = {
  threshold_pcts: [50, 75, 80, 90],
  expiry_warning_days: [30, 7],
  max_named_shares_per_grant: 5,
  max_extension_years: 5,
  reinstate_window_days: 365,
  renewal_charge_lead_days: 3,
  renewal_link_lead_days: 7,
  dunning_retry_days: [3, 7],
  dunning_expire_day: 10,
  yearly_reminder_days: [30, 7],
  monthly_reminder_days: [7],
  failed_renewals_alert_per_day: 3,
} as const;

/** Platform setting `credits`; every field defaults to the rule 6a value. */
export const CreditsSettings = z
  .object({
    threshold_pcts: pctList.default([...CREDITS_SETTINGS_DEFAULTS.threshold_pcts]),
    expiry_warning_days: dayList.default([...CREDITS_SETTINGS_DEFAULTS.expiry_warning_days]),
    max_named_shares_per_grant: z.number().int().min(0).max(50).default(CREDITS_SETTINGS_DEFAULTS.max_named_shares_per_grant),
    max_extension_years: z.number().int().min(1).max(20).default(CREDITS_SETTINGS_DEFAULTS.max_extension_years),
    reinstate_window_days: z.number().int().min(0).max(3653).default(CREDITS_SETTINGS_DEFAULTS.reinstate_window_days),
    renewal_charge_lead_days: z.number().int().min(0).max(30).default(CREDITS_SETTINGS_DEFAULTS.renewal_charge_lead_days),
    renewal_link_lead_days: z.number().int().min(0).max(30).default(CREDITS_SETTINGS_DEFAULTS.renewal_link_lead_days),
    dunning_retry_days: z
      .array(z.number().int().min(1).max(60))
      .length(2)
      .refine(([a, b]) => (a ?? 0) < (b ?? 0), "retry days must increase")
      .default([...CREDITS_SETTINGS_DEFAULTS.dunning_retry_days]),
    dunning_expire_day: z.number().int().min(2).max(90).default(CREDITS_SETTINGS_DEFAULTS.dunning_expire_day),
    yearly_reminder_days: dayList.default([...CREDITS_SETTINGS_DEFAULTS.yearly_reminder_days]),
    monthly_reminder_days: dayList.default([...CREDITS_SETTINGS_DEFAULTS.monthly_reminder_days]),
    failed_renewals_alert_per_day: z.number().int().min(1).max(100).default(CREDITS_SETTINGS_DEFAULTS.failed_renewals_alert_per_day),
  })
  .refine((s) => s.dunning_expire_day > Math.max(...s.dunning_retry_days), {
    message: "dunning_expire_day must come after the last retry",
    path: ["dunning_expire_day"],
  });
export type CreditsSettings = z.infer<typeof CreditsSettings>;

// ---------------------------------------------------------------------------
// credit_grants.sharing
// ---------------------------------------------------------------------------

export const GrantSharingSchema = z.object({
  mode: z.enum(["none", "guests", "named"]),
  max_guest_uses_per_month: z.number().int().min(0).max(31),
  allowed_person_ids: z.array(uuid()),
});
export type GrantSharing = z.infer<typeof GrantSharingSchema>;

/** The column default: no sharing. */
export const NO_SHARING: GrantSharing = { mode: "none", max_guest_uses_per_month: 0, allowed_person_ids: [] };

/**
 * Sharing of a new grant (rule 2): a purchased package copies the product (`is_sharing_allowed`
 * false gives `none`, true gives `guests` with `max_guest_uses_per_month`, default 2); euro,
 * membership and every staff or reward grant are `none`.
 */
export function defaultSharingFor(i: {
  kind: "day" | "night" | "euro";
  source: (typeof GRANT_SOURCES)[number];
  isSharingAllowed?: boolean;
  maxGuestUsesPerMonth?: number | null;
}): GrantSharing {
  if (i.kind === "euro" || i.source !== "purchase" || !i.isSharingAllowed) return { ...NO_SHARING, allowed_person_ids: [] };
  return { mode: "guests", max_guest_uses_per_month: i.maxGuestUsesPerMonth ?? 2, allowed_person_ids: [] };
}

// ---------------------------------------------------------------------------
// grantCredits (02-data-model 6.5, rules 1, 1a, 4, 6, 20a)
// ---------------------------------------------------------------------------

export const GrantCreditsInputSchema = z
  .object({
    personId: uuid(),
    kind: CreditKindSchema,
    units: z.number().int().positive(),
    source: z.enum(["purchase", "voucher", "bonus", "manual", "import", "referral"]),
    productId: uuid().optional(),
    orderLineId: uuid().optional(),
    lineUnitIndex: z.number().int().positive().max(32767).optional(),
    voucherId: uuid().optional(),
    refundId: uuid().optional(),
    unitValueCents: z.number().int().min(0).optional(),
    vatRatePct: z
      .number()
      .refine((v) => (VAT_RATES as readonly number[]).includes(v), "vat rate must be 0, 6, 12 or 21")
      .nullable()
      .optional(),
    sharing: GrantSharingSchema.optional(),
    label: LocalizedTextSchema.optional(),
    startsAt: z.date().optional(),
    expiresAt: z.date().nullable(),
    reason: z.string().trim().min(1).max(500).optional(),
    key: z.string().trim().min(7).startsWith("grant:"),
    data: z
      .object({
        original_units: z.number().int().positive().optional(),
        legacy_source: z.string().max(100).optional(),
        legacy_id: z.string().max(200).optional(),
        import_id: uuid().optional(),
      })
      .strict()
      .optional(),
  })
  .superRefine((v, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (v.source === "purchase") {
      if (v.kind === "euro") issue("kind", "a purchase grant is day or night");
      if (!v.orderLineId) issue("orderLineId", "required for a purchase");
      if (v.lineUnitIndex === undefined) issue("lineUnitIndex", "required for a purchase");
    }
    if (v.source === "voucher") {
      if (v.kind !== "euro") issue("kind", "a voucher grant is euro");
      if (!v.voucherId) issue("voucherId", "required for a voucher");
      if (!v.orderLineId) issue("orderLineId", "required for a voucher");
    }
    if (v.refundId !== undefined && !(v.source === "manual" && v.kind === "euro")) issue("refundId", "only for a manual euro restore");
    if (v.kind === "euro" && v.unitValueCents !== undefined && v.unitValueCents !== 1) issue("unitValueCents", "a euro unit is one cent");
    if (v.kind === "euro" && v.sharing && v.sharing.mode !== "none") issue("sharing", "euro grants are never shared");
    if (v.startsAt && v.expiresAt && !(v.expiresAt.getTime() > v.startsAt.getTime())) issue("expiresAt", "must be after startsAt");
    if (v.data?.original_units !== undefined && v.data.original_units < v.units) issue("data", "original_units below units");
  });
export type GrantCreditsInput = z.infer<typeof GrantCreditsInputSchema>;

// ---------------------------------------------------------------------------
// Staff actions on grants (section 4, actions table)
// ---------------------------------------------------------------------------

/** `credits.create_grant`: manual or bonus grant, one validity of three, euro alone may have none. */
export const CreateGrantInput = z
  .object({
    personId: uuid(),
    kind: CreditKindSchema,
    units: z.number().int().min(1).max(100_000),
    source: z.enum(["manual", "bonus"]),
    label: completeLocalizedText(),
    validityDays: z.number().int().min(1).max(1825).optional(),
    expiresAt: z.coerce.date().optional(),
    noExpiry: z.literal(true).optional(),
    reason: reason(),
    sharingMode: z.enum(["none", "guests", "named"]).optional(),
    clientKey: uuid(),
  })
  .superRefine((v, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (v.kind !== "euro" && v.units > 100) issue("units", "at most 100 sessions or nights");
    const validities = [v.validityDays !== undefined, v.expiresAt !== undefined, v.noExpiry === true].filter(Boolean).length;
    if (validities !== 1) issue("validityDays", "choose exactly one validity");
    if (v.noExpiry && v.kind !== "euro") issue("noExpiry", "only euro store credit may have no expiry");
    if (v.kind === "euro" && v.sharingMode && v.sharingMode !== "none") issue("sharingMode", "euro grants are never shared");
  });
export type CreateGrantInput = z.infer<typeof CreateGrantInput>;

/** `credits.adjust_grant`. */
export const AdjustGrantInput = z.object({
  grantId: uuid(),
  quantity: z
    .number()
    .int()
    .refine((q) => q !== 0, "quantity must not be 0"),
  reason: reason(),
  clientKey: uuid(),
});
export type AdjustGrantInput = z.infer<typeof AdjustGrantInput>;

/** `credits.extend_grant` (the 5-year cap and the later-than-old check need the grant: rule 31). */
export const ExtendGrantInput = z.object({
  grantId: uuid(),
  newExpiresAt: z.coerce.date(),
  reason: reason(),
  clientKey: uuid(),
});
export type ExtendGrantInput = z.infer<typeof ExtendGrantInput>;

/** `credits.revoke_grant`. */
export const RevokeGrantInput = z.object({ grantId: uuid(), reason: reason(), clientKey: uuid() });
export type RevokeGrantInput = z.infer<typeof RevokeGrantInput>;

/** `credits.transfer`. */
export const TransferCreditsInput = z.object({
  grantId: uuid(),
  toPersonId: uuid(),
  units: z.number().int().min(1).max(100_000),
  reason: reason(),
  clientKey: uuid(),
});
export type TransferCreditsInput = z.infer<typeof TransferCreditsInput>;

/** `credits.update_note`. */
export const UpdateGrantNoteInput = z.object({ grantId: uuid(), note: z.string().max(1000) });
export type UpdateGrantNoteInput = z.infer<typeof UpdateGrantNoteInput>;

/** `credits.bulk_extend` (rule 32a): membership grants are never bulk-extended. */
export const BulkExtendInput = z
  .object({
    days: z.number().int().min(1).max(90),
    reason: reason(),
    kinds: z.array(CreditKindSchema).min(1).default(["day", "night"]),
    sources: z
      .array(z.enum(["purchase", "voucher", "bonus", "import", "manual", "referral", "transfer"]))
      .min(1)
      .default(["purchase", "import", "voucher", "bonus", "manual"]),
    expiresFromOn: dateOn(),
    expiresToOn: dateOn(),
    clientKey: uuid(),
  })
  .refine((v) => v.expiresToOn >= v.expiresFromOn, { message: "end date before start date", path: ["expiresToOn"] });
export type BulkExtendInput = z.infer<typeof BulkExtendInput>;

// ---------------------------------------------------------------------------
// Memberships and plans
// ---------------------------------------------------------------------------

const version = () => z.number().int().min(1);

/** `memberships.cancel` (`pending` and `past_due` allow only `now`, checked against the row). */
export const CancelMembershipInput = z.object({
  membershipId: uuid(),
  mode: z.enum(["period_end", "now"]),
  reason: reason(),
  version: version(),
});
export type CancelMembershipInput = z.infer<typeof CancelMembershipInput>;

/** `memberships.resume`, also the customer's `resumeMyMembership` and `cancelMyMembership`. */
export const ResumeMembershipInput = z.object({ membershipId: uuid(), version: version() });
export type ResumeMembershipInput = z.infer<typeof ResumeMembershipInput>;

/** `memberships.extend_period` (rule 55, a pause). */
export const ExtendMembershipPeriodInput = z.object({
  membershipId: uuid(),
  days: z.number().int().min(1).max(90),
  reason: reason(),
  alsoExtendInclusions: z.boolean().default(false),
  clientKey: uuid(),
  version: version(),
});
export type ExtendMembershipPeriodInput = z.infer<typeof ExtendMembershipPeriodInput>;

/** `memberships.update_notes`. */
export const UpdateMembershipNotesInput = z.object({ membershipId: uuid(), notes: z.string().max(2000), version: version() });
export type UpdateMembershipNotesInput = z.infer<typeof UpdateMembershipNotesInput>;

/** `memberships.set_benefit` (at most 12 active rows per plan, checked against the table). */
export const PlanBenefitInput = z.object({
  productId: uuid(),
  benefitId: uuid().optional(),
  kind: z.enum(PLAN_BENEFIT_KINDS),
  text: completeLocalizedText(),
  sortOrder: z.number().int().min(0).max(99).default(0),
  isActive: z.boolean().default(true),
});
export type PlanBenefitInput = z.infer<typeof PlanBenefitInput>;

/** `removePlanBenefit`. */
export const RemovePlanBenefitInput = z.object({ benefitId: uuid() });
export type RemovePlanBenefitInput = z.infer<typeof RemovePlanBenefitInput>;

/** `memberships.set_inclusion`. */
export const PlanInclusionInput = z.object({
  productId: uuid(),
  kind: z.enum(["day", "night"]),
  unitsPerPeriod: z.number().int().min(1).max(62),
  isActive: z.boolean().default(true),
});
export type PlanInclusionInput = z.infer<typeof PlanInclusionInput>;
