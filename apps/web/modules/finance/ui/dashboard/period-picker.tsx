/**
 * The dashboard period selector (finance spec section 5, rule 44): links for today, this week,
 * this month and year to date, and a GET form for a custom range. The selection lives in the URL
 * (`?period=`, `?from=`, `?to=`), so it is bookmarkable and works without JavaScript. The current
 * choice carries `aria-current`.
 */
import Link from "next/link";
import { Button, cn, Input, Label } from "@beam/ui";
import type { DashboardLabel } from "./format";

export const PRESET_PERIODS = ["day", "week", "month", "ytd"] as const;

export type PeriodPickerProps = {
  current: "day" | "week" | "month" | "ytd" | "custom";
  from: string;
  to: string;
  l: DashboardLabel;
};

const pill = (active: boolean) =>
  cn(
    "rounded-md border px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    active ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted",
  );

export function PeriodPicker({ current, from, to, l }: PeriodPickerProps) {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <nav aria-label={l("period_legend")} className="flex flex-wrap gap-2" data-testid="period-picker">
        {PRESET_PERIODS.map((p) => (
          <Link
            key={p}
            href={{ pathname: "/admin/finance/dashboard", query: { period: p } }}
            className={pill(p === current)}
            aria-current={p === current ? "page" : undefined}
            data-period={p}
          >
            {l(`period_${p}`)}
          </Link>
        ))}
      </nav>
      <form method="get" action="/admin/finance/dashboard" className="flex flex-wrap items-end gap-2" aria-label={l("period_custom")}>
        <input type="hidden" name="period" value="custom" />
        <div className="grid gap-1">
          <Label htmlFor="dashboard-from">{l("from")}</Label>
          <Input id="dashboard-from" name="from" type="date" defaultValue={from} required className="w-40" />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="dashboard-to">{l("to")}</Label>
          <Input id="dashboard-to" name="to" type="date" defaultValue={to} required className="w-40" />
        </div>
        <Button type="submit" variant={current === "custom" ? "default" : "outline"} aria-pressed={current === "custom"}>
          {l("apply")}
        </Button>
      </form>
    </div>
  );
}
