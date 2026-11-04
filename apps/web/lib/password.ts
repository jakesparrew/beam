/**
 * Passwords (PL-1, PL-2, PL-13). argon2id with the OWASP parameters; a hash made with weaker
 * parameters is rehashed after a successful login. The server enforces length, the zxcvbn
 * score and the email rule; the Have I Been Pwned range check runs in the browser
 * (`modules/platform/ui/hibp.ts`), because a request never calls an external service.
 */
import { randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

/** PL-2: memoryCost 19456 KiB, timeCost 2, parallelism 1 (argon2id is the library default). */
export const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export type PasswordAudience = "staff" | "customer";

/** PL-1 (staff) and PL-13 (customers). */
export const PASSWORD_RULES: Readonly<Record<PasswordAudience, { minLength: number; minScore: number }>> = {
  staff: { minLength: 12, minScore: 3 },
  customer: { minLength: 10, minScore: 2 },
};

/** Upper bound so a megabyte "password" cannot tie up argon2 or zxcvbn. */
export const PASSWORD_MAX_LENGTH = 256;

export type PasswordPolicyReason = "too_short" | "too_long" | "too_weak" | "same_as_email";

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

let dummy: Promise<string> | undefined;

/**
 * A real argon2id hash of a random password, made once per instance. Sign-in verifies against
 * it when the account is unknown, disabled or has no password, so every miss pays the same
 * argon2 work as a real account and timing does not reveal which emails exist (PL-7).
 */
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString("hex"));
  return dummy;
}

/** True when `password` matches the PHC string. A malformed hash is a mismatch, never a throw. */
export async function verifyPassword(password: string, phc: string | null | undefined): Promise<boolean> {
  if (!phc || !phc.startsWith("$argon2")) return false;
  try {
    return await verify(phc, password);
  } catch {
    return false;
  }
}

/** PL-2: a hash that is not argon2id or uses weaker parameters than `ARGON2_OPTIONS`. */
export function needsRehash(phc: string): boolean {
  const m = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(phc);
  if (!m) return true;
  const [memory, time, parallelism] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return memory < ARGON2_OPTIONS.memoryCost || time < ARGON2_OPTIONS.timeCost || parallelism < ARGON2_OPTIONS.parallelism;
}

type Zxcvbn = { check(password: string, userInputs?: (string | number)[]): { score: number } };
let zxcvbn: Promise<Zxcvbn> | undefined;

/** The zxcvbn estimator with the common, English, Dutch (Belgium) and French dictionaries, built once. */
function estimator(): Promise<Zxcvbn> {
  zxcvbn ??= (async () => {
    const [core, common, en, nl, fr] = await Promise.all([
      import("@zxcvbn-ts/core"),
      import("@zxcvbn-ts/language-common"),
      import("@zxcvbn-ts/language-en"),
      import("@zxcvbn-ts/language-nl-be"),
      import("@zxcvbn-ts/language-fr"),
    ]);
    return new core.ZxcvbnFactory({
      dictionary: { ...common.dictionary, ...en.dictionary, ...nl.dictionary, ...fr.dictionary },
      graphs: common.adjacencyGraphs,
      translations: en.translations,
    });
  })();
  return zxcvbn;
}

/** The zxcvbn score (0 to 4) with the email and its local part as user inputs. */
export async function passwordScore(password: string, userInputs: string[] = []): Promise<number> {
  return (await estimator()).check(password.slice(0, 100), userInputs).score;
}

/** PL-1 / PL-13 server checks. `reasons` is empty when `ok`. */
export async function checkPasswordPolicy(
  password: string,
  opts: { audience: PasswordAudience; email?: string | null },
): Promise<{ ok: boolean; reasons: string[] }> {
  const rule = PASSWORD_RULES[opts.audience];
  const reasons: PasswordPolicyReason[] = [];
  if (password.length < rule.minLength) reasons.push("too_short");
  if (password.length > PASSWORD_MAX_LENGTH) reasons.push("too_long");
  const email = (opts.email ?? "").trim().toLowerCase();
  const local = email.split("@")[0] ?? "";
  const lowered = password.trim().toLowerCase();
  if (email && (lowered === email || (local.length >= 3 && lowered === local))) reasons.push("same_as_email");
  if (password.length <= PASSWORD_MAX_LENGTH) {
    const inputs = [email, local, ...local.split(/[._+-]/)].filter((s) => s.length >= 3);
    if ((await passwordScore(password, inputs)) < rule.minScore) reasons.push("too_weak");
  }
  return { ok: reasons.length === 0, reasons };
}
