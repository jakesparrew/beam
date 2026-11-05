/**
 * The conflict report table of `/admin/automations/conflicts` (automation spec 5, R2,
 * automation-P7): per (lost, won) journey pair the blocked (`skipped_exclusive`) and superseded
 * counts, the last occurrence (Europe/Brussels) and up to five sample persons linking to the
 * person page (only with `persons.read`); both journeys link to their overview. The period
 * switch (7 or 30 days) is a pair of links, so it works without JavaScript. Server component.
 */
import Link from "next/link";
import { EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { formatDateTime, formatNumber, type Locale } from "@beam/core/i18n";
import type { ConflictAutomation, ConflictReport } from "../queries";
import { fill, type Labels } from "./outcome-badge";

export type ConflictReportViewProps = { report: ConflictReport; canSeePersons: boolean; labels: Labels; locale: Locale };

export function ConflictPeriodSwitch({ days, labels: l }: { days: 7 | 30; labels: Labels }) {
  const options = [
    { days: 7 as const, label: l["conflicts.period_7"] },
    { days: 30 as const, label: l["conflicts.period_30"] },
  ];
  return (
    <nav aria-label={l["conflicts.period"]} className="flex gap-1" data-testid="conflicts-period">
      {options.map((o) => (
        <Link
          key={o.days}
          href={`/admin/automations/conflicts?days=${o.days}` as never}
          aria-current={o.days === days ? "page" : undefined}
          className={`rounded-md border px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
            o.days === days ? "border-primary bg-primary text-primary-foreground" : "border-input hover:bg-muted"
          }`}
        >
          {o.label}
        </Link>
      ))}
    </nav>
  );
}

function AutomationCell({ a, l }: { a: ConflictAutomation; l: Labels }) {
  return (
    <>
      <Link className="font-medium underline-offset-2 hover:underline" href={`/admin/automations/${a.id}`}>
        {a.name}
      </Link>
      <span className="block font-mono text-xs text-muted-foreground">
        {a.slug} · {fill(l["conflicts.group"], { key: a.groupKey })}
      </span>
    </>
  );
}

export function ConflictReportView({ report, canSeePersons, labels: l, locale }: ConflictReportViewProps) {
  if (report.pairs.length === 0) return <EmptyState title={l["conflicts.empty"]} />;
  return (
    <div className="grid gap-3">
      <p className="text-sm" data-testid="conflicts-totals">
        {fill(l["conflicts.totals"], { skipped: formatNumber(report.totals.skippedExclusive, locale), superseded: formatNumber(report.totals.superseded, locale) })}
      </p>
      <p className="text-xs text-muted-foreground">{l["common.times_in_zone"]}</p>
      <Table data-testid="conflicts-table">
        <TableHeader>
          <TableRow>
            <TableHead>{l["conflicts.col_blocked"]}</TableHead>
            <TableHead>{l["conflicts.col_blocking"]}</TableHead>
            <TableHead className="text-right">{l["conflicts.col_skipped"]}</TableHead>
            <TableHead className="text-right">{l["conflicts.col_superseded"]}</TableHead>
            <TableHead>{l["conflicts.col_last"]}</TableHead>
            <TableHead>{l["conflicts.col_persons"]}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {report.pairs.map((p) => (
            <TableRow key={`${p.blocked.id}:${p.blocking.id}`} data-blocked={p.blocked.slug} data-blocking={p.blocking.slug}>
              <TableCell>
                <AutomationCell a={p.blocked} l={l} />
              </TableCell>
              <TableCell>
                <AutomationCell a={p.blocking} l={l} />
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(p.skippedExclusive, locale)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(p.superseded, locale)}</TableCell>
              <TableCell>
                <time dateTime={p.lastAt.toISOString()}>{formatDateTime(p.lastAt, locale)}</time>
              </TableCell>
              <TableCell>
                {canSeePersons ? (
                  <ul className="grid gap-0.5 text-sm">
                    {p.samplePersons.map((person) => (
                      <li key={person.id}>
                        <Link className="underline-offset-2 hover:underline" href={`/admin/persons/${person.id}`}>
                          {person.name ?? l["conflicts.unnamed"]}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-xs text-muted-foreground">{l["conflicts.persons_hidden"]}</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
