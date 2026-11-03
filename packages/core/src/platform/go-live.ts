/**
 * The go-live gate (blueprint 77, PL-77, PL-85): 13 items in `settings.go_live_gate`, each
 * confirmed by an owner or technical_admin with a note.
 */
export const GO_LIVE_ITEMS = [
  "dpa_signed",
  "subprocessors_confirmed",
  "region_confirmed",
  "transfers_documented",
  "ai_no_training_confirmed",
  "retention_agreed",
  "export_tested",
  "deletion_tested",
  "security_confirmed",
  "backup_confirmed",
  "recovery_confirmed",
  "permissions_configured",
  "acceptance_passed",
] as const;

export type GateItemKey = (typeof GO_LIVE_ITEMS)[number];

export type GateItem = { confirmed_by_user_id: string | null; confirmed_at: string | null; note: string | null };

export type GoLiveGate = { items: Partial<Record<GateItemKey, GateItem | null>> };

/** Roles that may confirm an item. */
export const GO_LIVE_CONFIRM_ROLES = ["owner", "technical_admin"] as const;

/** The pentest is due 92 days after the last one (PL-85). */
export const PENTEST_INTERVAL_DAYS = 92;
/** `security_confirmed` needs a pentest within this many days. */
export const PENTEST_FRESH_DAYS = 30;
/** Reminders start this many days before the due date. */
export const PENTEST_REMINDER_DAYS = 7;

export function isGateItemConfirmed(item: GateItem | null | undefined): boolean {
  return !!item && !!item.confirmed_by_user_id && !!item.confirmed_at && !!item.note && item.note.trim().length > 0;
}

export function missingGateItems(gate: GoLiveGate | null | undefined): GateItemKey[] {
  return GO_LIVE_ITEMS.filter((key) => !isGateItemConfirmed(gate?.items?.[key]));
}

export function isGateComplete(gate: GoLiveGate | null | undefined): boolean {
  return missingGateItems(gate).length === 0;
}

export function emptyGoLiveGate(): GoLiveGate {
  return { items: Object.fromEntries(GO_LIVE_ITEMS.map((k) => [k, null])) };
}

function dayNumber(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

function addDays(isoDate: string, days: number): string {
  return new Date((dayNumber(isoDate) + days) * 86_400_000).toISOString().slice(0, 10);
}

/** `last_pentest_on + 92 days` as `YYYY-MM-DD`. */
export function nextPentestDueOn(lastPentestOn: string): string {
  return addDays(lastPentestOn, PENTEST_INTERVAL_DAYS);
}

/**
 * Whether `security_confirmed` may be confirmed on `today` (Brussels date): the last pentest is
 * at most 30 days old and no critical or high incident is open.
 */
export function canConfirmSecurity(input: { lastPentestOn: string | null; today: string; openCriticalOrHighIncidents: number }): {
  ok: boolean;
  reason: "no_pentest" | "pentest_too_old" | "open_incidents" | null;
} {
  if (!input.lastPentestOn) return { ok: false, reason: "no_pentest" };
  const age = dayNumber(input.today) - dayNumber(input.lastPentestOn);
  if (age < 0 || age > PENTEST_FRESH_DAYS) return { ok: false, reason: "pentest_too_old" };
  if (input.openCriticalOrHighIncidents > 0) return { ok: false, reason: "open_incidents" };
  return { ok: true, reason: null };
}

/** True from 7 days before the due date onward (a daily reminder in `platform.check_alerts`). */
export function isPentestReminderDue(nextDueOn: string | null, today: string): boolean {
  if (!nextDueOn) return false;
  return dayNumber(today) >= dayNumber(nextDueOn) - PENTEST_REMINDER_DAYS;
}
