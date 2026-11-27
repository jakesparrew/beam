/**
 * The initials avatar commerce's own client components use (the till's buyer search and buyer
 * card). It mirrors booking's `ui/kit.tsx` `Initials`, which commerce may not import (PL-82:
 * another module only through its `api.ts`).
 * ponytail: a copy of booking's avatar; import a shared one once platform exposes a client-safe kit.
 * No hooks, so server pages and client components both render it.
 */
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
