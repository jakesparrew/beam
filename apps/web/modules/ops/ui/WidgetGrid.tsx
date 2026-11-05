/**
 * The widget grid of a custom dashboard (ops spec 5, rule 79). Presentational and hook-free, so
 * the server page renders it with values it formatted itself: a `number` widget is a KPI tile, a
 * `bar` widget shows horizontal bars (the breakdown rows, or this period against the previous
 * one), a `line` widget a small SVG line of the daily series, and a `table` widget the breakdown
 * rows. Raw values stay in `data-value` for tests; colour is never the only signal.
 */
import { Card, CardContent, CardHeader, CardTitle, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import type { DashboardDefinition } from "@beam/core/ops";
import { ChangeBadge, type ChangeBadgeProps } from "./ChangeBadge";

type Viz = DashboardDefinition["widgets"][number]["viz"];

export type WidgetRowView = { key: string; label: string; value: string; raw: number; previous: string | null };

export type WidgetView = {
  id: string;
  title: string;
  viz: Viz;
  /** Period, "as of now" or segment, shown under the title. */
  note: string;
  /** A message when the widget could not be evaluated. */
  error: string | null;
  value: string | null;
  raw: number | null;
  /** "Previous period: …", null without comparison. */
  previous: string | null;
  previousRaw: number | null;
  change: Omit<ChangeBadgeProps, "locale"> | null;
  rows?: WidgetRowView[];
  series?: { day: string; value: number }[];
};

export type WidgetGridLabels = { item: string; value: string; previous: string; current: string; empty: string };

export function WidgetGrid({ widgets, labels, locale }: { widgets: WidgetView[]; labels: WidgetGridLabels; locale: string }) {
  if (widgets.length === 0) return <p className="text-sm text-muted-foreground">{labels.empty}</p>;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="widget-grid">
      {widgets.map((w) => (
        <Card key={w.id} data-testid={`widget-${w.id}`} data-value={w.raw ?? ""} className={w.viz === "table" || w.viz === "line" ? "sm:col-span-2 xl:col-span-1" : undefined}>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">{w.title}</CardTitle>
            <p className="text-xs text-muted-foreground">{w.note}</p>
          </CardHeader>
          <CardContent className="grid gap-3">{w.error ? <p role="status" className="text-sm text-muted-foreground">{w.error}</p> : <WidgetBody w={w} labels={labels} locale={locale} />}</CardContent>
        </Card>
      ))}
    </div>
  );
}

function Headline({ w, locale }: { w: WidgetView; locale: string }) {
  return (
    <div className="grid gap-2">
      <span className="text-2xl font-semibold tabular-nums" data-testid={`widget-${w.id}-value`}>
        {w.value ?? "-"}
      </span>
      {w.previous !== null ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {w.change ? <ChangeBadge {...w.change} locale={locale} /> : null}
          <span>{w.previous}</span>
        </div>
      ) : null}
    </div>
  );
}

function WidgetBody({ w, labels, locale }: { w: WidgetView; labels: WidgetGridLabels; locale: string }) {
  if (w.viz === "table" && w.rows) {
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{labels.item}</TableHead>
            <TableHead className="text-right">{labels.value}</TableHead>
            {w.rows.some((r) => r.previous !== null) ? <TableHead className="text-right">{labels.previous}</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {w.rows.map((r) => (
            <TableRow key={r.key} data-key={r.key} data-value={r.raw}>
              <TableCell>{r.label}</TableCell>
              <TableCell className="text-right tabular-nums">{r.value}</TableCell>
              {r.previous !== null ? <TableCell className="text-right tabular-nums">{r.previous}</TableCell> : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }
  if (w.viz === "bar") {
    const bars: { key: string; label: string; value: string; raw: number }[] = w.rows
      ? w.rows.map((r) => ({ key: r.key, label: r.label, value: r.value, raw: r.raw }))
      : [
          { key: "current", label: labels.current, value: w.value ?? "-", raw: w.raw ?? 0 },
          ...(w.previous !== null ? [{ key: "previous", label: labels.previous, value: w.previous, raw: w.previousRaw ?? 0 }] : []),
        ];
    const max = Math.max(1, ...bars.map((b) => Math.abs(b.raw)));
    return (
      <ul className="grid gap-2">
        {bars.map((b) => (
          <li key={b.key} className="grid gap-1" data-key={b.key} data-value={b.raw}>
            <div className="flex justify-between gap-2 text-sm">
              <span>{b.label}</span>
              <span className="tabular-nums">{b.value}</span>
            </div>
            <div className="h-2 rounded bg-muted" aria-hidden="true">
              <div className="h-2 rounded bg-primary" style={{ width: `${Math.round((Math.abs(b.raw) / max) * 100)}%` }} />
            </div>
          </li>
        ))}
      </ul>
    );
  }
  if (w.viz === "line" && w.series && w.series.length > 0) {
    return (
      <>
        <Headline w={w} locale={locale} />
        <Sparkline series={w.series} label={`${w.title}: ${w.value ?? "-"}`} />
      </>
    );
  }
  return <Headline w={w} locale={locale} />;
}

function Sparkline({ series, label }: { series: { day: string; value: number }[]; label: string }) {
  const W = 300;
  const H = 60;
  const values = series.map((p) => p.value);
  const min = Math.min(0, ...values);
  const max = Math.max(1, ...values);
  const x = (i: number) => (series.length === 1 ? W / 2 : (i / (series.length - 1)) * W);
  const y = (v: number) => H - ((v - min) / (max - min)) * H;
  const points = series.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-16 w-full text-primary" role="img" aria-label={label} data-points={series.length}>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
