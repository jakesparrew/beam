/**
 * KPI tiles of the email overview and the campaign report (email spec section 5). Pure markup
 * without hooks, so server and client components both render it. Values arrive formatted.
 */
export type KpiTile = { key: string; label: string; value: string; hint?: string | null; tone?: "default" | "warning" | "danger" };

const TONE: Record<NonNullable<KpiTile["tone"]>, string> = {
  default: "",
  warning: "border-amber-500/60",
  danger: "border-destructive text-destructive",
};

export function KpiTiles({ tiles, testId }: { tiles: readonly KpiTile[]; testId?: string }) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid={testId}>
      {tiles.map((t) => (
        <div key={t.key} className={`rounded-md border p-3 ${TONE[t.tone ?? "default"]}`} data-kpi={t.key}>
          <dt className="text-xs text-muted-foreground">{t.label}</dt>
          <dd className="text-xl font-semibold tabular-nums" data-kpi-value>
            {t.value}
          </dd>
          {t.hint ? <dd className="text-xs text-muted-foreground">{t.hint}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

/** `12.3 %` in the locale, or an en dash without a denominator. */
export function formatRate(locale: string, value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "–";
  return new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(value);
}

export function formatCount(locale: string, value: number): string {
  return new Intl.NumberFormat(locale).format(value);
}
