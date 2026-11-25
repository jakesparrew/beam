/**
 * The portal's first-sign-in onboarding (owner requirements item 10): four optional steps, one
 * per screen. Every step is answered or skipped on its own; the flow is done when each step has
 * an outcome, or the client dismissed it. The answers live in their usual places (person
 * columns, consent records, company contacts); `persons.onboarding` only tracks the progress.
 */
export const ONBOARDING_STEPS = ["emergency", "communication", "company", "about"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type OnboardingOutcome = "answered" | "skipped";

export type OnboardingState = {
  seen_at?: string;
  dismissed_at?: string;
  steps?: Partial<Record<string, OnboardingOutcome>>;
};

export type OnboardingProgress = {
  /** The flow was never shown: the portal home opens it once. */
  unseen: boolean;
  answered: number;
  total: number;
  /** Every step has an outcome, or the client dismissed the flow: no more "Complete your profile" card. */
  done: boolean;
  /** The first step without an outcome (the one "Continue" opens), `null` when every step has one. */
  next: OnboardingStep | null;
};

export function onboardingProgress(state: OnboardingState | null | undefined): OnboardingProgress {
  const steps = state?.steps ?? {};
  const next = ONBOARDING_STEPS.find((s) => !steps[s]) ?? null;
  return {
    unseen: !state?.seen_at,
    answered: ONBOARDING_STEPS.filter((s) => steps[s] === "answered").length,
    total: ONBOARDING_STEPS.length,
    done: next === null || !!state?.dismissed_at,
    next,
  };
}
