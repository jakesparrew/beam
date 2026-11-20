/**
 * The lead score (docs/plan/modules/assistant.md section 5.5): fixed rules over the analyst's
 * reading and what the visitor did, 0 to 100, with the reason in plain words. Rules rather than a
 * model's opinion, so staff can explain and tune it. 60 or more with an email address is qualified.
 */
export const LEAD_INTENTS = ["booking", "pricing", "membership", "gift", "b2b", "information", "support", "complaint", "other"] as const;
export const LEAD_INTERESTS = ["day", "night", "package", "membership", "gift_card", "event", "webinar", "b2b"] as const;
export const LEAD_OBJECTIONS = ["price", "time", "distance", "health", "doubt", "other"] as const;

export type LeadIntent = (typeof LEAD_INTENTS)[number];

export type ScoreInput = {
  hasEmail: boolean;
  hasPhone: boolean;
  intent: LeadIntent;
  urgency: "low" | "medium" | "high" | null;
  sentiment: "positive" | "neutral" | "negative" | null;
  interests: readonly string[];
  bookingLinkClicked: boolean;
};

const INTENT_POINTS: Record<LeadIntent, number> = { booking: 30, membership: 25, pricing: 20, gift: 20, b2b: 20, information: 10, other: 5, support: 5, complaint: 0 };

export const QUALIFIED_SCORE = 60;
export const WARM_SCORE = 35;

export function scoreLead(input: ScoreInput): { score: number; parts: { label: string; points: number }[]; qualified: boolean; temperature: "hot" | "warm" | "cold" } {
  const parts: { label: string; points: number }[] = [];
  if (input.hasEmail) parts.push({ label: "email", points: 25 });
  if (input.hasPhone) parts.push({ label: "phone", points: 10 });
  parts.push({ label: `intent:${input.intent}`, points: INTENT_POINTS[input.intent] });
  if (input.urgency === "high") parts.push({ label: "urgency:high", points: 15 });
  if (input.urgency === "medium") parts.push({ label: "urgency:medium", points: 8 });
  if (input.bookingLinkClicked) parts.push({ label: "booking_link", points: 10 });
  if (input.interests.length) parts.push({ label: "interests", points: 5 });
  if (input.sentiment === "negative") parts.push({ label: "sentiment:negative", points: -10 });
  const score = Math.max(0, Math.min(100, parts.reduce((s, p) => s + p.points, 0)));
  const temperature = score >= QUALIFIED_SCORE ? "hot" : score >= WARM_SCORE ? "warm" : "cold";
  return { score, parts: parts.filter((p) => p.points !== 0), qualified: score >= QUALIFIED_SCORE && input.hasEmail, temperature };
}

/** "email +25 · intent:booking +30" — the reason line staff see next to the score. */
export function scoreReason(parts: readonly { label: string; points: number }[]): string {
  return parts.map((p) => `${p.label} ${p.points > 0 ? "+" : ""}${p.points}`).join(" · ");
}
