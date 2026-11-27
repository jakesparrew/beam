/**
 * Small shared pieces of the assistant's back-office: the card surface, a cost formatter (gateway
 * prices are in dollars; a single answer often costs a fraction of a cent, so small amounts keep
 * four decimals) and the score pill. The header and tabs are the page kit's (`AssistantHeader`).
 */

/** The back-office kit's hairline surface (owner review, November 2026). */
export const SURFACE = "rounded-xl border border-border bg-card";

export function usd(cents: number | null | undefined): string {
  if (cents == null) return "–";
  const dollars = cents / 100;
  const digits = dollars === 0 ? 2 : dollars < 0.01 ? 4 : dollars < 1 ? 3 : 2;
  return `$${dollars.toFixed(digits)}`;
}

/** A 0-100 score as a coloured pill. */
export function ScorePill({ score }: { score: number | null }) {
  if (score == null) return <span className="text-xs text-muted-foreground">–</span>;
  const cls = score >= 60 ? "bg-[#fde7e3] text-[#b42318]" : score >= 35 ? "bg-[#fdf0dc] text-[#a0621e]" : "bg-muted text-muted-foreground";
  return <span className={`inline-flex min-w-9 justify-center rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${cls}`}>{score}</span>;
}
