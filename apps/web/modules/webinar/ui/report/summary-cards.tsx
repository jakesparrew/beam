/**
 * Report summary cards (webinar spec 5.1 `/admin/webinars/[id]/report`; webinar-P6). A server
 * component: every text and value arrives formatted, so it holds no catalogue or locale logic.
 * The value is text (never colour only, rule 44).
 */
import { Card, CardContent, CardHeader, CardTitle } from "@beam/ui";

export type SummaryCard = { key: string; label: string; value: string; hint?: string };

export function SummaryCards({ cards, label }: { cards: readonly SummaryCard[]; label: string }) {
  return (
    <section aria-label={label} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((c) => (
        <Card key={c.key} data-testid={`summary-${c.key}`}>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">{c.label}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{c.value}</p>
            {c.hint ? <p className="mt-1 text-xs text-muted-foreground">{c.hint}</p> : null}
          </CardContent>
        </Card>
      ))}
    </section>
  );
}
