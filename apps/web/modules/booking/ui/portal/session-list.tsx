/**
 * The session list of `/[locale]/account/book` (booking spec 5.2, 5.4): one card per session,
 * each a link with an accessible name ("Tuesday 14 January, 10:00, Day session, 3 places
 * left"). Availability is written out, never shown by colour alone; the member-only and
 * "Opens for you on ..." messages are text badges. Every text comes from the page, already
 * translated and formatted; the component renders only.
 */
import Link from "next/link";
import type { Route } from "next";
import { Badge, cn } from "@beam/ui";

export type SessionListItem = {
  sessionId: string;
  href: string;
  /** "10:00 – 12:00". */
  timeLabel: string;
  title: string;
  /** "3 places left", "Available", "Full", "Closed for booking", ... */
  availabilityLabel: string;
  /** "1 session from your package" or "€ 25,00 per session"; null when free or unknown. */
  priceLabel: string | null;
  /** "For members" when member-only. */
  memberLabel: string | null;
  /** "Opens for you on ..." (lead window) or the opening time of a session not open yet. */
  opensLabel: string | null;
  /** The card's accessible name. */
  ariaLabel: string;
  /** Full, closed or not open: shown muted, still a link (waitlist or details). */
  muted: boolean;
};

export function SessionList({ items, emptyLabel }: { items: SessionListItem[]; emptyLabel: string }) {
  if (items.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-muted-foreground" data-testid="session-list-empty">
        {emptyLabel}
      </p>
    );
  }
  return (
    <ul className="grid gap-3" data-testid="session-list">
      {items.map((s) => (
        <li key={s.sessionId}>
          <Link
            href={s.href as Route}
            aria-label={s.ariaLabel}
            data-testid={`session-card-${s.sessionId}`}
            className={cn(
              "flex min-h-11 flex-col gap-1 rounded-lg border p-4 outline-none transition hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring sm:flex-row sm:items-center sm:justify-between",
              s.muted && "bg-muted/40",
            )}
          >
            <span className="flex flex-col">
              <span className="font-medium">
                {s.timeLabel} · {s.title}
              </span>
              {s.priceLabel ? <span className="text-sm text-muted-foreground">{s.priceLabel}</span> : null}
              {s.opensLabel ? <span className="text-sm">{s.opensLabel}</span> : null}
            </span>
            <span className="flex flex-wrap items-center gap-2">
              {s.memberLabel ? <Badge variant="secondary">{s.memberLabel}</Badge> : null}
              <span className={cn("text-sm font-medium", s.muted && "text-muted-foreground")}>{s.availabilityLabel}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
