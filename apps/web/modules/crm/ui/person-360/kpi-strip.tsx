/**
 * The 360 KPI strip (crm spec 5.1) from ops' `getPersonStats`: revenue, purchases, visits,
 * no-shows, last visit and lifetime value, formatted by the server (money in EUR, dates in
 * Europe/Brussels). Without stats (ops has not computed them yet, or its panel failed) it shows
 * "Not available yet". Every string is a prop.
 */
export type KpiItem = { key: string; label: string; value: string };

export function KpiStrip({ title, items, notAvailable }: { title: string; items: KpiItem[] | null; notAvailable: string }) {
  return (
    <section aria-label={title} data-testid="kpi-strip" className="rounded-lg border p-4">
      {items ? (
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {items.map((k) => (
            <div key={k.key} className="grid gap-1">
              <dt className="text-xs text-muted-foreground">{k.label}</dt>
              <dd className="text-lg font-semibold tabular-nums">{k.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">{notAvailable}</p>
      )}
    </section>
  );
}
