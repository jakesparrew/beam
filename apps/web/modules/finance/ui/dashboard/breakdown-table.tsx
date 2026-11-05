/**
 * A breakdown as a real table with an inline bar per row (finance-P8: revenue by category and by
 * payment method). The bar is decorative (`aria-hidden`); the amounts are in the cells, so the
 * table reads the same with or without colour. Negative amounts draw no bar.
 */
import { Badge, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";

export type BreakdownRow = { key: string; label: string; current: number; previous: number; lastYear: number; badge?: string };

export type BreakdownTableProps = {
  id: string;
  caption: string;
  labelHeader: string;
  headers: { current: string; previous: string; lastYear: string };
  rows: BreakdownRow[];
  emptyLabel: string;
  format: (value: number) => string;
};

export function BreakdownTable({ id, caption, labelHeader, headers, rows, emptyLabel, format }: BreakdownTableProps) {
  const max = Math.max(1, ...rows.filter((r) => !r.badge).map((r) => r.current));
  return (
    <Table data-testid={`breakdown-${id}`}>
      <TableCaption className="sr-only">{caption}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{labelHeader}</TableHead>
          <TableHead scope="col" className="text-right">
            {headers.current}
          </TableHead>
          <TableHead scope="col" className="text-right">
            {headers.previous}
          </TableHead>
          <TableHead scope="col" className="text-right">
            {headers.lastYear}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={4} className="text-muted-foreground">
              {emptyLabel}
            </TableCell>
          </TableRow>
        ) : (
          rows.map((r) => (
            <TableRow key={r.key} data-key={r.key} data-value={r.current}>
              <TableCell>
                <div className="grid gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    {r.label}
                    {r.badge ? <Badge variant="outline">{r.badge}</Badge> : null}
                  </span>
                  {r.badge ? null : (
                    <span aria-hidden="true" className="block h-1.5 rounded-full bg-muted">
                      <span className="block h-1.5 rounded-full bg-primary" style={{ width: `${Math.max(0, (r.current / max) * 100)}%` }} />
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">{format(r.current)}</TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">{format(r.previous)}</TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">{format(r.lastYear)}</TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
