/**
 * One timeline row (crm spec 5.1, rules 3.26, 3.36, 3.37): time, category, the summary the server
 * built from the kind's catalogue entry (an unknown kind arrives as its raw kind string), the
 * mode for webinar activity, an optional detail line (a note's body, an interaction's summary).
 * A sensitive note shows only the placeholder and, for holders of `persons.sensitive_read`, a
 * Reveal button; the revealed body is passed in by the timeline and never stored. Every string
 * is a prop.
 */
import { Badge, Button } from "@beam/ui";

export type TimelineRowView = {
  id: string;
  /** ISO timestamp, for `<time dateTime>` and the paging cursor. */
  occurredAt: string;
  /** Formatted in Europe/Brussels by the server. */
  timeLabel: string;
  kind: string;
  category: string;
  categoryLabel: string;
  summary: string;
  detail: string | null;
  modeLabel: string | null;
  isSensitive: boolean;
  /** True when no catalogue entry exists: `summary` is the raw kind. */
  isUnknown: boolean;
};

export type EventRowLabels = { sensitiveNote: string; reveal: string };

export function EventRow({
  row,
  labels,
  canReveal,
  revealed,
  revealing,
  onReveal,
}: {
  row: TimelineRowView;
  labels: EventRowLabels;
  canReveal: boolean;
  revealed?: string | null;
  revealing?: boolean;
  onReveal?: (id: string) => void;
}) {
  return (
    <li className="grid gap-1 border-b py-3 last:border-b-0" data-testid="timeline-row" data-kind={row.kind} data-category={row.category}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <time className="text-muted-foreground" dateTime={row.occurredAt}>
          {row.timeLabel}
        </time>
        <Badge variant="outline">{row.categoryLabel}</Badge>
        {row.modeLabel ? <Badge variant="secondary">{row.modeLabel}</Badge> : null}
      </div>
      {row.isSensitive ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium" data-testid="sensitive-placeholder">
            {labels.sensitiveNote}
          </span>
          {revealed ? (
            <p className="w-full whitespace-pre-wrap" data-testid="sensitive-revealed">
              {revealed}
            </p>
          ) : canReveal && onReveal ? (
            <Button type="button" size="sm" variant="outline" disabled={revealing} onClick={() => onReveal(row.id)}>
              {labels.reveal}
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <p className={row.isUnknown ? "font-mono text-sm" : "text-sm font-medium"}>{row.summary}</p>
          {row.detail ? <p className="whitespace-pre-wrap text-sm text-muted-foreground">{row.detail}</p> : null}
        </>
      )}
    </li>
  );
}
