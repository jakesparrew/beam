/**
 * Feature flag evaluation (PL-43, platform section 2 `feature_flags`). A declared flag
 * without a row is `off`. A flag is on for a subject when its state is `on`, or `testers`
 * and the subject's user or person is a tester or is listed in `user_ids` / `person_ids`.
 */
export const FLAG_STATES = ["off", "testers", "on"] as const;
export type FlagState = (typeof FLAG_STATES)[number];

export const FLAG_KEY_PATTERN = /^ff_[a-z]+_[a-z0-9_]+$/;

export type FlagRow = {
  state: FlagState;
  userIds?: readonly string[] | null;
  personIds?: readonly string[] | null;
};

/** Who is asking. Everything is optional: an anonymous visitor only sees flags that are `on`. */
export type FlagSubject = {
  userId?: string | null;
  personId?: string | null;
  userIsTester?: boolean | null;
  personIsTester?: boolean | null;
};

export function isFlagOn(flag: FlagRow | null | undefined, subject: FlagSubject = {}): boolean {
  if (!flag) return false;
  if (flag.state === "on") return true;
  if (flag.state !== "testers") return false;
  if (subject.userIsTester || subject.personIsTester) return true;
  if (subject.userId && flag.userIds?.includes(subject.userId)) return true;
  if (subject.personId && flag.personIds?.includes(subject.personId)) return true;
  return false;
}

export function isValidFlagKey(key: string): boolean {
  return FLAG_KEY_PATTERN.test(key);
}
