/**
 * The CTA table of the report (rule 40; webinar-P6): persons shown and clicking per mode, CTR,
 * booked after and purchased after the first click within the period. A server component.
 */
import { formatNumber, formatPercent, type Locale } from "@beam/core/i18n";
import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { WATCH_MODES, type WatchMode } from "@beam/core/webinar";

export type CtaResultView = {
  ctaId: string;
  key: string;
  label: string;
  isActive: boolean;
  shown: Record<WatchMode, number>;
  clicked: Record<WatchMode, number>;
  ctr: number | null;
  bookedAfter: number;
  purchasedAfter: number;
};

export type CtaTableLabels = {
  title: string;
  empty: string;
  cta: string;
  /** Contain `{mode}`. */
  shown: string;
  clicked: string;
  ctr: string;
  bookedAfter: string;
  purchasedAfter: string;
  inactive: string;
  modes: Record<WatchMode, string>;
};

export function CtaTable({ ctas, labels, locale }: { ctas: readonly CtaResultView[]; labels: CtaTableLabels; locale: Locale }) {
  const withMode = (template: string, m: WatchMode) => template.replace("{mode}", labels.modes[m]);
  return (
    <section aria-labelledby="report-ctas" className="grid gap-3">
      <h2 id="report-ctas" className="text-lg font-semibold">
        {labels.title}
      </h2>
      {ctas.length === 0 ? (
        <p className="text-sm text-muted-foreground">{labels.empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table data-testid="report-ctas">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{labels.cta}</TableHead>
                {WATCH_MODES.flatMap((m) => [
                  <TableHead key={`s-${m}`} scope="col" className="text-right">
                    {withMode(labels.shown, m)}
                  </TableHead>,
                  <TableHead key={`c-${m}`} scope="col" className="text-right">
                    {withMode(labels.clicked, m)}
                  </TableHead>,
                ])}
                <TableHead scope="col" className="text-right">
                  {labels.ctr}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {labels.bookedAfter}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {labels.purchasedAfter}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ctas.map((c) => (
                <TableRow key={c.ctaId}>
                  <TableHead scope="row" className="font-normal">
                    {c.label} <span className="text-muted-foreground">({c.key})</span>{" "}
                    {c.isActive ? null : <Badge variant="outline">{labels.inactive}</Badge>}
                  </TableHead>
                  {WATCH_MODES.flatMap((m) => [
                    <TableCell key={`s-${m}`} className="text-right tabular-nums">
                      {formatNumber(c.shown[m], locale)}
                    </TableCell>,
                    <TableCell key={`c-${m}`} className="text-right tabular-nums">
                      {formatNumber(c.clicked[m], locale)}
                    </TableCell>,
                  ])}
                  <TableCell className="text-right tabular-nums">{c.ctr === null ? "–" : formatPercent(c.ctr, locale)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(c.bookedAfter, locale)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(c.purchasedAfter, locale)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
