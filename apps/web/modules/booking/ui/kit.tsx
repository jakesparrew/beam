/**
 * The back-office table pieces booking's own client components use (owner review, November
 * 2026): the small initials avatar, the status pill and the `th`/`td` cell classes. The pill and
 * the cell classes mirror platform's `admin-kit`, which booking's components may not import
 * (PL-82: another module only through its `api.ts`, and that one is server code).
 * ponytail: a copy of four admin-kit lines; import the kit once platform exposes a client-safe one.
 * No hooks, so server pages and client tables both render these.
 */
import type { ReactNode } from "react";
import { cn } from "@beam/ui";

const AVATAR_TONES = ["bg-[#fde7d3] text-[#9a3412]", "bg-[#e0e7ff] text-[#3730a3]", "bg-[#dcfce7] text-[#166534]", "bg-[#f7eedc] text-[#8a5a14]", "bg-[#fce7f3] text-[#9d174d]"];

/** Two letters on a soft colour picked from the id, so a person keeps the same colour on every page. */
export function Initials({ id, name, className }: { id: string; name: string | null; className?: string }) {
  const letters =
    (name ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join("") || "?";
  const tone = AVATAR_TONES[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_TONES.length]!;
  return (
    <span aria-hidden="true" className={cn("grid size-8 shrink-0 place-items-center rounded-full text-[0.6875rem] font-semibold", tone, className)}>
      {letters}
    </span>
  );
}

export type Tone = "ok" | "warn" | "bad" | "info" | "full" | "muted" | "gold";
const TONES: Record<Tone, string> = {
  ok: "bg-[var(--status-ok-soft)] text-[var(--status-ok)]",
  warn: "bg-[var(--status-warn-soft)] text-[var(--status-warn)]",
  bad: "bg-[var(--status-bad-soft)] text-[var(--status-bad)]",
  info: "bg-[var(--status-info-soft)] text-[var(--status-info)]",
  full: "bg-[var(--status-full)] text-white",
  muted: "bg-muted text-muted-foreground",
  gold: "bg-[#f7eedc] text-[#8a5a14]",
};

export function StatusPill({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[0.6875rem] leading-4 font-semibold whitespace-nowrap", TONES[tone], className)}>{children}</span>;
}

/** Column header cell and body cell classes for hairline data tables. */
export const th = "px-3 py-2 text-left text-[0.75rem] font-medium whitespace-nowrap text-muted-foreground first:pl-5 last:pr-5";
export const td = "px-3 py-2.5 align-middle first:pl-5 last:pr-5";
