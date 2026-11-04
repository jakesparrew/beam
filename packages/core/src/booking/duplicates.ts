/**
 * Duplicate protection for waitlist joins and direct lead seats (booking spec R48, edge cases
 * 15 and 16). Signals flag an entry for staff review; nothing is merged automatically.
 */
import { hkdfSha256, sha256, toHex } from "./claim-token";

/** The IP signal only counts within this window (R48). */
export const IP_SIGNAL_WINDOW_MS = 24 * 3_600_000;

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/** Lower-case, `+tag` removed, gmail dots removed (`j.doe+beam@gmail.com` -> `jdoe@gmail.com`). */
export function normaliseEmail(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at < 1) return lower;
  let local = lower.slice(0, at);
  let domain = lower.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replaceAll(".", "");
    domain = "gmail.com";
  }
  return `${local}@${domain}`;
}

/** Digits only, with a leading `00` read as `+` and Belgian `0` trunk prefix as `+32`. */
export function normalisePhone(phone: string): string {
  let p = phone.trim().replace(/[\s().\-/]/g, "");
  if (p.startsWith("00")) p = `+${p.slice(2)}`;
  else if (p.startsWith("0")) p = `+32${p.slice(1)}`;
  return p;
}

export type DupCandidate = {
  /** Waitlist entry or booking id, used in the signal text. */
  id: string;
  personId: string;
  emailNormalised: string | null;
  phone: string | null;
  lastName: string | null;
  /** `YYYY-MM-DD`. */
  birthOn: string | null;
  joinIpHash: string | null;
  joinedAt: Date;
  queue: "lead" | "customer" | "public" | null;
};

/**
 * R48: the reasons `candidate` looks like a second identity of someone in `others` (entries and
 * live bookings of the same session): same normalised email, same phone, same last name and
 * birth date, or the same IP hash within 24 h in the `lead` queue. `[]` = clean. Each signal
 * reads `<signal>:<other id>`, the format of `waitlist_entries.flag_reason`.
 */
export function duplicateSignals(candidate: DupCandidate, others: DupCandidate[]): string[] {
  const signals: string[] = [];
  const phone = candidate.phone ? normalisePhone(candidate.phone) : null;
  const lastName = candidate.lastName?.trim().toLowerCase() || null;
  for (const o of others) {
    if (o.personId === candidate.personId || o.id === candidate.id) continue;
    if (candidate.emailNormalised && o.emailNormalised === candidate.emailNormalised) signals.push(`same_normalised_email:${o.id}`);
    if (phone && o.phone && normalisePhone(o.phone) === phone) signals.push(`same_phone:${o.id}`);
    if (lastName && candidate.birthOn && o.birthOn === candidate.birthOn && o.lastName?.trim().toLowerCase() === lastName) {
      signals.push(`same_name_birth:${o.id}`);
    }
    if (
      candidate.joinIpHash &&
      candidate.queue === "lead" &&
      o.queue === "lead" &&
      o.joinIpHash === candidate.joinIpHash &&
      Math.abs(candidate.joinedAt.getTime() - o.joinedAt.getTime()) <= IP_SIGNAL_WINDOW_MS
    ) {
      signals.push(`same_ip:${o.id}`);
    }
  }
  return signals;
}

/** The IP salt: `HKDF(AUTH_SECRET, info 'beam-ip-v1')`. */
export function deriveIpSalt(authSecret: string): Uint8Array {
  return hkdfSha256(authSecret, "", "beam-ip-v1", 32);
}

/** `join_ip_hash = sha256(ip || salt)` as hex; null without an IP (the signal is then skipped). */
export function hashIp(ip: string | null, salt: Uint8Array): string | null {
  if (!ip) return null;
  const ipBytes = new TextEncoder().encode(ip);
  const buf = new Uint8Array(ipBytes.length + salt.length);
  buf.set(ipBytes);
  buf.set(salt, ipBytes.length);
  return toHex(sha256(buf));
}
