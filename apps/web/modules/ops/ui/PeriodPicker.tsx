/**
 * The period picker and VAT toggle of the revenue report (ops rules 34 and 35): plain links that
 * set `?period=`, `?vat=` and keep `?at=`, so the selection is part of the URL (bookmarkable,
 * no client state) and works without JavaScript. The current choice carries `aria-current`.
 */
import type { Route } from "next";
import Link from "next/link";
import { cn } from "@beam/ui";

export type PeriodPickerProps<P extends string> = {
  pathname: Route;
  periods: readonly { value: P; label: string }[];
  current: { period: P; vat: "incl" | "excl"; at?: string };
  vatLabels: { incl: string; excl: string; legend: string };
  periodLegend: string;
};

const pill = (active: boolean) =>
  cn(
    "rounded-md border px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    active ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted",
  );

export function PeriodPicker<P extends string>({ pathname, periods, current, vatLabels, periodLegend }: PeriodPickerProps<P>) {
  const query = (over: Partial<{ period: string; vat: string }>) => ({
    period: over.period ?? current.period,
    vat: over.vat ?? current.vat,
    ...(current.at ? { at: current.at } : {}),
  });
  return (
    <div className="flex flex-wrap items-center gap-4">
      <nav aria-label={periodLegend} className="flex flex-wrap gap-2" data-testid="period-picker">
        {periods.map((p) => (
          <Link
            key={p.value}
            href={{ pathname, query: query({ period: p.value }) }}
            className={pill(p.value === current.period)}
            aria-current={p.value === current.period ? "page" : undefined}
            data-period={p.value}
          >
            {p.label}
          </Link>
        ))}
      </nav>
      <nav aria-label={vatLabels.legend} className="flex gap-2" data-testid="vat-toggle">
        {(["incl", "excl"] as const).map((v) => (
          <Link key={v} href={{ pathname, query: query({ vat: v }) }} className={pill(v === current.vat)} aria-current={v === current.vat ? "page" : undefined} data-vat={v}>
            {vatLabels[v]}
          </Link>
        ))}
      </nav>
    </div>
  );
}
