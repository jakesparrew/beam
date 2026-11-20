/**
 * Small shared pieces of the assistant's back-office: the card surface, a KPI tile, a cost
 * formatter (gateway prices are in dollars; a single answer often costs a fraction of a cent, so
 * small amounts keep four decimals) and the sub-navigation of the section.
 */
import Link from "next/link";
import type { Route } from "next";
import type { ReactNode } from "react";

export const SURFACE = "rounded-[1.25rem] bg-card shadow-[0_1px_2px_rgb(33_40_66/0.04),0_12px_32px_-18px_rgb(33_40_66/0.22)]";

export function usd(cents: number | null | undefined): string {
  if (cents == null) return "–";
  const dollars = cents / 100;
  const digits = dollars === 0 ? 2 : dollars < 0.01 ? 4 : dollars < 1 ? 3 : 2;
  return `$${dollars.toFixed(digits)}`;
}

export function Kpi({ label, value, hint, tone = "default" }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "default" | "gold" | "navy" | "alert" }) {
  const toneClass =
    tone === "navy" ? "bg-[#212842] text-[#fffaef]" : tone === "gold" ? "bg-[#f6efdf]" : tone === "alert" ? "bg-[#fdecea]" : "bg-card";
  return (
    <div className={`rounded-[1.25rem] shadow-[0_1px_2px_rgb(33_40_66/0.04),0_12px_32px_-18px_rgb(33_40_66/0.22)] ${toneClass} grid content-between gap-2 p-4`}>
      <p className={`text-xs ${tone === "navy" ? "text-[#fffaef]/65" : "text-muted-foreground"}`}>{label}</p>
      <p className="text-3xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className={`text-xs ${tone === "navy" ? "text-[#fffaef]/60" : "text-muted-foreground"}`}>{hint}</p> : null}
    </div>
  );
}

export function SubNav({ active, items }: { active: string; items: { key: string; href: string; label: string }[] }) {
  return (
    <nav className="flex flex-wrap gap-2" aria-label="assistant">
      {items.map((i) => (
        <Link
          key={i.key}
          href={i.href as Route}
          aria-current={i.key === active ? "page" : undefined}
          className="rounded-full border px-3.5 py-1.5 text-sm hover:bg-accent aria-[current=page]:border-[#212842] aria-[current=page]:bg-[#212842] aria-[current=page]:text-[#fffaef]"
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

type Tr = (key: string, params?: Record<string, string | number>) => string;

export function assistantSubNav(tr: Tr) {
  return [
    { key: "overview", href: "/admin/assistant", label: tr("assistant.nav.overview") },
    { key: "conversations", href: "/admin/assistant/conversations", label: tr("assistant.nav.conversations") },
    { key: "eval", href: "/admin/assistant/eval", label: tr("assistant.nav.eval") },
    { key: "settings", href: "/admin/assistant/settings", label: tr("assistant.nav.settings") },
  ];
}

/** A 0-100 score as a coloured pill. */
export function ScorePill({ score }: { score: number | null }) {
  if (score == null) return <span className="text-xs text-muted-foreground">–</span>;
  const cls = score >= 60 ? "bg-[#fde7e3] text-[#b42318]" : score >= 35 ? "bg-[#fdf0dc] text-[#a0621e]" : "bg-muted text-muted-foreground";
  return <span className={`inline-flex min-w-9 justify-center rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${cls}`}>{score}</span>;
}
