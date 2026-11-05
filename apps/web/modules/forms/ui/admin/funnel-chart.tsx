/**
 * The form funnel (forms spec section 5 `/admin/forms/[formId]/report`; forms-P6): views, started,
 * engaged, completed and abandoned as horizontal bars relative to the largest step, each with its
 * number and share of starts as text (no information in colour alone). Server-rendered markup.
 */
import { formatNumber, formatPercent, type Locale } from "@beam/core/i18n";
import { lbl, type Labels } from "./submission-table";

export type FunnelChartProps = {
  steps: { views: number; started: number; engaged: number; completed: number; abandoned: number };
  locale: Locale;
  labels: Labels;
};

const STEPS = ["views", "started", "engaged", "completed", "abandoned"] as const;

export function FunnelChart({ steps, locale, labels }: FunnelChartProps) {
  const max = Math.max(1, ...STEPS.map((s) => steps[s]));
  return (
    <figure className="grid gap-2" aria-label={lbl(labels, "report.chart_label")}>
      <ul className="grid gap-2">
        {STEPS.map((s) => {
          const value = steps[s];
          const share = s !== "views" && s !== "started" && steps.started ? formatPercent((value / steps.started) * 100, locale) : null;
          return (
            <li key={s} className="grid grid-cols-[8rem_minmax(0,1fr)_6rem] items-center gap-3 text-sm" data-step={s}>
              <span>{lbl(labels, `report.${s}`)}</span>
              <span className="h-5 rounded bg-muted" aria-hidden="true">
                <span className={`block h-5 rounded ${s === "abandoned" ? "bg-destructive/60" : "bg-primary"}`} style={{ width: `${Math.round((value / max) * 100)}%` }} />
              </span>
              <span className="text-right tabular-nums">
                {formatNumber(value, locale)}
                {share ? <span className="text-muted-foreground"> ({share})</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}
