/**
 * One figure with its comparison (ops rule 34): a label, the formatted value, the previous
 * period's value and the change badge. `value` stays available as `data-value` for tests and
 * e2e checks (cents or a count), so assertions never parse the localised text.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@beam/ui";
import { ChangeBadge, type ChangeBadgeProps } from "./ChangeBadge";

export type KpiTileProps = {
  label: string;
  value: number;
  formattedValue: string;
  /** "Previous period: € 1.234,00". */
  previousLabel: string;
  change: Omit<ChangeBadgeProps, "locale">;
  locale: string;
  testId?: string;
};

export function KpiTile({ label, value, formattedValue, previousLabel, change, locale, testId }: KpiTileProps) {
  return (
    <Card data-testid={testId} data-value={value}>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        <span className="text-2xl font-semibold tabular-nums" data-testid={testId ? `${testId}-value` : undefined}>
          {formattedValue}
        </span>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <ChangeBadge {...change} locale={locale} />
          <span>{previousLabel}</span>
        </div>
      </CardContent>
    </Card>
  );
}
