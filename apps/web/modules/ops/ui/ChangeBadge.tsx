/**
 * The change against the previous period (ops rule 34): absolute change and percentage with an
 * explicit + or - sign, so colour is never the only signal (ops spec 5). The percentage is blank
 * when the previous value was 0; `blankLabel` then explains why (screen readers and tooltip).
 */
import { Badge } from "@beam/ui";

export type ChangeBadgeProps = {
  change: number;
  changePct: number | null;
  /** The absolute change, already formatted (money or count), without a sign. */
  formattedChange: string;
  /** `ops.period.change_blank`. */
  blankLabel: string;
  /** `ops.period.change`, read before the figure by screen readers. */
  label: string;
  locale: string;
};

export function ChangeBadge({ change, changePct, formattedChange, blankLabel, label, locale }: ChangeBadgeProps) {
  const sign = change > 0 ? "+" : change < 0 ? "-" : "±";
  const variant = change > 0 ? "success" : change < 0 ? "destructive" : "secondary";
  const pct =
    changePct === null ? null : `${changePct > 0 ? "+" : changePct < 0 ? "-" : "±"}${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(Math.abs(changePct))} %`;
  return (
    <Badge variant={variant} data-testid="change-badge" title={pct === null ? blankLabel : undefined}>
      <span className="sr-only">{label}: </span>
      {sign}
      {formattedChange}
      {pct === null ? <span className="sr-only"> ({blankLabel})</span> : <span> ({pct})</span>}
    </Badge>
  );
}
