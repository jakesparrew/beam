/**
 * One dashboard figure (finance spec section 5, rule 44): the value of the period, the change
 * against the previous period with an explicit sign (colour is never the only signal), and the
 * previous and last-year values in words. `data-value` keeps the raw figure (cents or a count) for
 * tests and e2e checks, so they never parse localised text.
 */
import type { Route } from "next";
import Link from "next/link";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@beam/ui";
import { formatNumber, type Locale } from "@beam/core/i18n";
import { changeOf, type DashboardLabel } from "./format";

export type KpiTileProps = {
  id: string;
  title: string;
  figure: { current: number; previous: number; lastYear: number };
  format: (value: number) => string;
  l: DashboardLabel;
  locale: Locale;
  href?: Route | { pathname: Route; query: Record<string, string> };
  /** Higher is worse (refunds, failed payments): the badge colour flips, the sign does not. */
  inverse?: boolean;
  note?: string;
};

export function KpiTile({ id, title, figure, format, l, locale, href, inverse = false, note }: KpiTileProps) {
  const { change, changePct } = changeOf(figure.current, figure.previous);
  const good = inverse ? change < 0 : change > 0;
  const variant = change === 0 ? "secondary" : good ? "success" : "destructive";
  const sign = change > 0 ? "+" : change < 0 ? "-" : "±";
  const pct =
    changePct === null ? null : `${changePct > 0 ? "+" : changePct < 0 ? "-" : "±"}${formatNumber(Math.abs(changePct), locale, { maximumFractionDigits: 1 })} %`;
  const value = <span className="text-2xl font-semibold tabular-nums">{format(figure.current)}</span>;
  return (
    <Card data-testid={`tile-${id}`} data-value={figure.current} data-previous={figure.previous} data-last-year={figure.lastYear}>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        {href ? (
          <Link href={href} className="w-fit underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {value}
          </Link>
        ) : (
          value
        )}
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant={variant} title={pct === null ? l("change_blank") : undefined}>
            <span className="sr-only">{l("change")}: </span>
            {sign}
            {format(Math.abs(change))}
            {pct === null ? <span className="sr-only"> ({l("change_blank")})</span> : <span> ({pct})</span>}
          </Badge>
          <span>{l("previous", { value: format(figure.previous) })}</span>
        </div>
        <span className="text-sm text-muted-foreground">{l("last_year", { value: format(figure.lastYear) })}</span>
        {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
      </CardContent>
    </Card>
  );
}
