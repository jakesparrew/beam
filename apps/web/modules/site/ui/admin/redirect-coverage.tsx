/**
 * Redirect coverage of a WordPress import (site rule 53, go-live runbook "redirect coverage at
 * 100 %"): the share of old paths and attachment URLs that resolve to a live page or a redirect,
 * and every old path that resolves to neither. Server component (no interaction).
 */
import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import type { Locale } from "@beam/core/i18n";
import type { SiteAdminLabels } from "../../queries/admin";
import type { RedirectCoverage as Coverage } from "../../queries/wordpress";
import { lbl } from "./pickers";

export function RedirectCoverage({ coverage, L, locale }: { coverage: Coverage; L: SiteAdminLabels; locale: Locale }) {
  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(coverage.percent / 100);
  const n = new Intl.NumberFormat(locale);
  return (
    <section aria-labelledby="wp-coverage" className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="wp-coverage" className="text-lg font-semibold">
          {lbl(L, "import.coverage")}
        </h2>
        <Badge variant={coverage.uncovered.length ? "destructive" : "default"}>{pct}</Badge>
        <span className="text-sm text-muted-foreground tabular-nums">
          {n.format(coverage.covered)} / {n.format(coverage.total)}
        </span>
      </div>
      {coverage.uncovered.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{lbl(L, "import.col.oldPath")}</TableHead>
              <TableHead>{lbl(L, "pages.col.title")}</TableHead>
              <TableHead>{lbl(L, "import.col.decision")}</TableHead>
              <TableHead>{lbl(L, "pages.col.status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {coverage.uncovered.map((u) => (
              <TableRow key={`${u.itemId}:${u.oldPath}`}>
                <TableCell className="font-mono text-xs">{u.oldPath}</TableCell>
                <TableCell>{u.title}</TableCell>
                <TableCell>{lbl(L, `import.decision.${u.decision}`)}</TableCell>
                <TableCell>{lbl(L, `import.itemStatus.${u.status}`)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </section>
  );
}
