/**
 * A server-rendered SVG column chart (finance-P8): one or two column series per bucket around a
 * zero baseline (credit notes can make a day negative) and an optional comparison line. Drawn
 * without a chart library (`recharts` is a dependency of `@beam/ui` only, which ships no chart
 * component yet), so it needs no client JavaScript. The SVG is `role="img"` with a summary; the
 * figures are always available as a real table in a `<details>` element (WCAG 1.1.1).
 */
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";

export type ColumnSeries = { key: string; label: string; values: number[]; className: string };
export type LineSeries = { key: string; label: string; values: number[]; className: string };

export type ColumnChartProps = {
  id: string;
  title: string;
  summary: string;
  showTableLabel: string;
  bucketHeader: string;
  buckets: { key: string; label: string }[];
  columns: ColumnSeries[];
  line?: LineSeries;
  /** Extra table-only series (for example last year). */
  extra?: LineSeries[];
  format: (value: number) => string;
};

const W = 720;
const H = 220;
const PAD_TOP = 12;
const PAD_BOTTOM = 24;

export function ColumnChart({ id, title, summary, showTableLabel, bucketHeader, buckets, columns, line, extra = [], format }: ColumnChartProps) {
  const all = [...columns.flatMap((s) => s.values), ...(line?.values ?? []), 0];
  const max = Math.max(...all);
  const min = Math.min(...all);
  const range = max - min || 1;
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const y = (v: number) => PAD_TOP + ((max - v) / range) * plotH;
  const zeroY = y(0);
  const n = Math.max(buckets.length, 1);
  const slot = W / n;
  const gap = Math.min(4, slot * 0.2);
  const colW = Math.max(1, (slot - gap) / Math.max(columns.length, 1));
  const labelEvery = Math.ceil(n / 12);
  const linePoints = line ? line.values.map((v, i) => `${(i + 0.5) * slot},${y(v)}`).join(" ") : "";
  const tableSeries = [...columns, ...(line ? [line] : []), ...extra];

  return (
    <figure className="grid gap-3" data-testid={`chart-${id}`}>
      <ul className="flex flex-wrap gap-4 text-sm text-muted-foreground" aria-hidden="true">
        {columns.map((s) => (
          <li key={s.key} className="flex items-center gap-2">
            <svg width="12" height="12" className={s.className}>
              <rect width="12" height="12" rx="2" />
            </svg>
            {s.label}
          </li>
        ))}
        {line ? (
          <li className="flex items-center gap-2">
            <svg width="16" height="12" className={line.className}>
              <line x1="0" y1="6" x2="16" y2="6" strokeWidth="2" strokeDasharray="4 2" />
            </svg>
            {line.label}
          </li>
        ) : null}
      </ul>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={summary}>
        <title>{title}</title>
        <line x1="0" x2={W} y1={zeroY} y2={zeroY} className="stroke-border" strokeWidth="1" />
        {buckets.map((b, i) =>
          columns.map((s, j) => {
            const v = s.values[i] ?? 0;
            const top = Math.min(y(v), zeroY);
            const height = Math.abs(zeroY - y(v));
            return <rect key={`${b.key}-${s.key}`} x={i * slot + gap / 2 + j * colW} y={top} width={colW} height={Math.max(height, v === 0 ? 0 : 1)} className={s.className} />;
          }),
        )}
        {line ? <polyline points={linePoints} fill="none" strokeWidth="2" strokeDasharray="6 3" className={line.className} vectorEffect="non-scaling-stroke" /> : null}
        {buckets.map((b, i) =>
          i % labelEvery === 0 ? (
            <text key={`label-${b.key}`} x={(i + 0.5) * slot} y={H - 6} textAnchor="middle" className="fill-muted-foreground text-[10px]">
              {b.label}
            </text>
          ) : null,
        )}
      </svg>
      <figcaption className="sr-only">{summary}</figcaption>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground underline-offset-4 hover:underline">{showTableLabel}</summary>
        <Table>
          <TableCaption>{title}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{bucketHeader}</TableHead>
              {tableSeries.map((s) => (
                <TableHead key={s.key} scope="col" className="text-right">
                  {s.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {buckets.map((b, i) => (
              <TableRow key={b.key}>
                <TableCell>{b.label}</TableCell>
                {tableSeries.map((s) => (
                  <TableCell key={s.key} className="text-right tabular-nums">
                    {format(s.values[i] ?? 0)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </details>
    </figure>
  );
}
