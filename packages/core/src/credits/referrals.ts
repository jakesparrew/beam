/**
 * R3 referral and partner rules (credits spec rules 60 to 63, section 2 "R3 state machines";
 * credits-P9). Pure: no I/O. Codes, self-referral detection, the commission amount, the
 * qualification and commission windows, the Brussels payment month, the `referrals` setting and
 * the attribution and commission status machines.
 */
import { addDays, addMonths } from "date-fns";
import { z } from "zod";
import { ConflictError } from "./state-machines";

// ---------------------------------------------------------------------------
// Codes (rule 60)
// ---------------------------------------------------------------------------

/** `A-HJ-NP-Z2-9`: no `I`, `O`, `0` or `1`, so a code read aloud or copied by hand stays right. */
export const REFERRAL_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** Personal codes have 8 characters; staff partner codes 6 to 12 of `A-Z0-9`. */
export const PERSONAL_CODE_LENGTH = 8;
export const REFERRAL_CODE_RE = /^[A-Z0-9]{6,12}$/;

/** A random source in [0, 1); the default uses the Web Crypto API. */
export type RandomSource = () => number;

const cryptoRandom: RandomSource = () => {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0]! / 2 ** 32;
};

/** A new personal code of `length` characters from `REFERRAL_CODE_ALPHABET`. */
export function generateReferralCode(rand: RandomSource = cryptoRandom, length = PERSONAL_CODE_LENGTH): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    const n = Math.min(REFERRAL_CODE_ALPHABET.length - 1, Math.floor(rand() * REFERRAL_CODE_ALPHABET.length));
    out += REFERRAL_CODE_ALPHABET[n];
  }
  return out;
}

/** Trimmed and upper-cased (codes are unique on `upper(code)`). */
export function normalizeReferralCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isValidReferralCode(code: string): boolean {
  return REFERRAL_CODE_RE.test(code);
}

// ---------------------------------------------------------------------------
// Self-referral (rule 61)
// ---------------------------------------------------------------------------

export type ReferralParty = { personId: string; email?: string | null; phone?: string | null };

const normEmail = (e?: string | null) => (e ? e.trim().toLowerCase() : "");
/** Digits only, a leading `00` or Belgian trunk `0` folded into `32` so `+32 470…`, `0032470…` and `0470…` match. */
export function normalizePhone(p?: string | null): string {
  if (!p) return "";
  let d = p.replace(/[^0-9]/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = `32${d.slice(1)}`;
  return d.length >= 6 ? d : "";
}

/** Same person, same lower-case email or same phone (rule 61). */
export function isSelfReferral(referrer: ReferralParty, referred: ReferralParty): boolean {
  if (referrer.personId === referred.personId) return true;
  const e = normEmail(referrer.email);
  if (e && e === normEmail(referred.email)) return true;
  const p = normalizePhone(referrer.phone);
  return !!p && p === normalizePhone(referred.phone);
}

// ---------------------------------------------------------------------------
// Commission (rule 63)
// ---------------------------------------------------------------------------

/** `pct` as stored (`numeric(5,2)`, e.g. `"12.50"`) in hundredths of a percent. */
function pctHundredths(pct: string | number): number {
  const n = typeof pct === "number" ? pct : Number(pct);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new RangeError(`invalid commission pct: ${pct}`);
  return Math.round(n * 100);
}

/**
 * `round_half_up(base_cents * pct / 100)`, symmetric for a refund's negative base so a full
 * refund cancels the accrual to the cent.
 */
export function commissionFor(input: { baseCents: number; pct: string | number }): number {
  if (!Number.isInteger(input.baseCents)) throw new RangeError("baseCents must be an integer");
  const h = pctHundredths(input.pct);
  const abs = Math.floor((Math.abs(input.baseCents) * h + 5000) / 10000);
  return input.baseCents < 0 ? -abs : abs;
}

/** `total_cents - vat_cents` of an order (the commission base). */
export function commissionBase(order: { totalCents: number; vatCents: number }): number {
  return Math.max(0, order.totalCents - order.vatCents);
}

/** A refund's negative base: the refunded share of the order's net total (rule 63). */
export function refundCommissionBase(input: { refundCents: number; orderTotalCents: number; orderVatCents: number }): number {
  if (input.orderTotalCents <= 0) return 0;
  const net = commissionBase({ totalCents: input.orderTotalCents, vatCents: input.orderVatCents });
  const share = Math.min(input.refundCents, input.orderTotalCents);
  return -Math.round((net * share) / input.orderTotalCents);
}

// ---------------------------------------------------------------------------
// Windows and months
// ---------------------------------------------------------------------------

/** `first_paid_at + qualification_days` (default 14). */
export function qualifiesAtFor(firstPaidAt: Date, days = 14): Date {
  return addDays(firstPaidAt, days);
}

/** `attributed_at + commission_months` (default 12). */
export function commissionUntilFor(attributedAt: Date, months = 12): Date {
  return addMonths(attributedAt, months);
}

const monthFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels", year: "numeric", month: "2-digit" });

/** The first day of the Brussels month of `at`, as `YYYY-MM-01` (`partner_commissions.period_month`). */
export function brusselsMonthStart(at: Date): string {
  const parts = Object.fromEntries(monthFmt.formatToParts(at).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-01`;
}

/** The Brussels calendar year of `at` (the yearly reward cap counts per calendar year). */
export function brusselsYear(at: Date): number {
  return Number(brusselsMonthStart(at).slice(0, 4));
}

// ---------------------------------------------------------------------------
// The `referrals` setting (rule 62; 02-data-model settings register)
// ---------------------------------------------------------------------------

export const ReferralReward = z.object({
  credit_kind: z.enum(["day", "night"]),
  units: z.number().int().min(1).max(20),
  validity_days: z.number().int().min(1).max(1825),
});
export type ReferralReward = z.infer<typeof ReferralReward>;

export const ReferralsSettings = z.object({
  /** The referrer's thank-you reward; null = none. A code's own `referrer_reward` wins. */
  referrer: ReferralReward.nullable(),
  /** The referred friend's reward; null = none. A code's own `referee_reward` wins. */
  referee: ReferralReward.nullable(),
  /** Rewarded referrals per referrer per calendar year (rule 62). */
  yearly_cap: z.number().int().min(0).max(1000),
  /** Days between the first paid order and the reward (refund window). */
  qualification_days: z.number().int().min(0).max(90),
  /** Months after attribution during which partner commission accrues (rule 63). */
  commission_months: z.number().int().min(1).max(60),
});
export type ReferralsSettings = z.infer<typeof ReferralsSettings>;

export const REFERRALS_SETTINGS_DEFAULTS: ReferralsSettings = {
  referrer: { credit_kind: "day", units: 1, validity_days: 180 },
  referee: null,
  yearly_cap: 10,
  qualification_days: 14,
  commission_months: 12,
};

// ---------------------------------------------------------------------------
// Status machines (section 2, R3)
// ---------------------------------------------------------------------------

export const REFERRAL_ATTRIBUTION_STATUSES = ["pending", "qualified", "rewarded", "rejected"] as const;
export type ReferralAttributionStatus = (typeof REFERRAL_ATTRIBUTION_STATUSES)[number];
export const REFERRAL_ATTRIBUTION_SOURCES = ["code", "link", "staff", "import"] as const;
export type ReferralAttributionSource = (typeof REFERRAL_ATTRIBUTION_SOURCES)[number];
export const PARTNER_COMMISSION_STATUSES = ["accrued", "approved", "paid", "void"] as const;
export type PartnerCommissionStatus = (typeof PARTNER_COMMISSION_STATUSES)[number];

/** Rejection reasons the system writes; staff may give any text of 3 to 500 characters. */
export const REJECTED_REASONS = ["self_referral", "already_customer", "cap_reached"] as const;

export const ATTRIBUTION_TRANSITIONS: readonly { from: ReferralAttributionStatus; to: ReferralAttributionStatus; trigger: string }[] = [
  { from: "pending", to: "qualified", trigger: "first paid order above 0 after attribution" },
  { from: "qualified", to: "pending", trigger: "that order fully refunded before qualifies_at" },
  { from: "qualified", to: "rewarded", trigger: "credits.qualify_referral_rewards at qualifies_at" },
  { from: "qualified", to: "rejected", trigger: "yearly cap reached (cap_reached)" },
  { from: "pending", to: "rejected", trigger: "self-referral, already_customer or staff rejectAttribution" },
];

export const COMMISSION_TRANSITIONS: readonly { from: PartnerCommissionStatus; to: PartnerCommissionStatus }[] = [
  { from: "accrued", to: "approved" },
  { from: "approved", to: "paid" },
  { from: "accrued", to: "void" },
  { from: "approved", to: "void" },
];

export function canTransitionAttribution(from: ReferralAttributionStatus, to: ReferralAttributionStatus): boolean {
  return ATTRIBUTION_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

export function assertAttributionTransition(from: ReferralAttributionStatus, to: ReferralAttributionStatus): void {
  if (!canTransitionAttribution(from, to)) throw new ConflictError(`attribution_transition:${from}->${to}`);
}

export function canTransitionCommission(from: PartnerCommissionStatus, to: PartnerCommissionStatus): boolean {
  return COMMISSION_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

export function assertCommissionTransition(from: PartnerCommissionStatus, to: PartnerCommissionStatus): void {
  if (!canTransitionCommission(from, to)) throw new ConflictError(`commission_transition:${from}->${to}`);
}

/** Idempotency keys of section 2 and rule 62. */
export const referralKeys = {
  referrerReward: (attributionId: string) => `grant:referral:${attributionId}:referrer`,
  refereeReward: (attributionId: string) => `grant:referral:${attributionId}:referee`,
  commission: (orderId: string) => `commission:${orderId}`,
  commissionRefund: (refundId: string) => `commission:refund:${refundId}`,
} as const;

/** The share link of a personal code (spec section 5, portal referrals). */
export function referralShareUrl(baseUrl: string, urlSegment: string, code: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${urlSegment}?ref=${encodeURIComponent(code)}`;
}
