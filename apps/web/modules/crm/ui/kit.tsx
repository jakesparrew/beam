/**
 * The back-office table pieces crm's own client components use (owner review, November 2026):
 * the initials avatar, the status pill, the `th`/`td` cell classes and the clickable-row classes.
 * They mirror platform's `admin-kit` and `admin-list-kit`, which crm's components may not import
 * (PL-82: another module only through its `api.ts`, and that one is server code).
 * ponytail: a copy of a few admin-kit lines (as booking/ui/kit.tsx); import the kit once platform
 * exposes a client-safe one. No hooks, so server pages and client tables both render these.
 */
import type { ReactNode } from "react";
import { cn } from "@beam/ui";

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

export function StatusPill({ tone, children, className, ...rest }: { tone: Tone; children: ReactNode; className?: string } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[0.6875rem] leading-4 font-semibold whitespace-nowrap", TONES[tone], className)} {...rest}>
      {children}
    </span>
  );
}

/** The initials of a name in a small round avatar (decorative: the name sits next to it). */
export function Initials({ name }: { name: string | null | undefined }) {
  const letters =
    (name ?? "")
      .split(/[\s-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => Array.from(w)[0]!.toUpperCase())
      .join("") || "–";
  return (
    <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-[0.6875rem] font-semibold text-muted-foreground">
      {letters}
    </span>
  );
}

const AVATAR_TONES = ["bg-[#fde7d3] text-[#9a3412]", "bg-[#e0e7ff] text-[#3730a3]", "bg-[#dcfce7] text-[#166534]", "bg-[#f7eedc] text-[#8a5a14]", "bg-[#fce7f3] text-[#9d174d]"];

/** Initials on a soft colour picked from the id, as booking's and the dashboard's avatars, so a person keeps one colour. */
export function PersonAvatar({ id, name, className }: { id: string; name: string | null | undefined; className?: string }) {
  const letters =
    (name ?? "")
      .split(/[\s-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => Array.from(w)[0]!.toUpperCase())
      .join("") || "–";
  const tone = AVATAR_TONES[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_TONES.length]!;
  return (
    <span aria-hidden="true" className={cn("grid size-8 shrink-0 place-items-center rounded-full text-[0.6875rem] font-semibold", tone, className)}>
      {letters}
    </span>
  );
}

/** A hairline surface (white, 12px corners); `flush` drops the padding for tables. */
export function Surface({ children, className, flush = false, ...rest }: { children: ReactNode; className?: string; flush?: boolean } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={cn("rounded-xl border border-border bg-card", !flush && "p-5", flush && "overflow-hidden", className)} {...rest}>
      {children}
    </section>
  );
}

/** Column header cell and body cell classes for hairline data tables. */
export const th = "px-3 py-2 text-left text-[0.75rem] font-medium whitespace-nowrap text-muted-foreground first:pl-5 last:pr-5";
export const td = "px-3 py-2.5 align-middle first:pl-5 last:pr-5";
export const theadClass = "bg-[#faf9f6]";
/** Classes that make a whole table row open the link in its first link cell (`tr` gets `rowClass`). */
export const rowClass = "relative border-b border-border last:border-b-0 hover:bg-[#faf9f6]";
export const rowLink = "after:absolute after:inset-0 after:content-['']";
/** Lifts a second link or button of a clickable row above the row's link. */
export const aboveRow = "relative z-10";
/** A quiet small button (row actions). */
export const quietButton = "inline-flex h-7 items-center rounded-md border border-border bg-card px-2.5 text-[0.75rem] font-semibold hover:bg-muted disabled:opacity-50";
