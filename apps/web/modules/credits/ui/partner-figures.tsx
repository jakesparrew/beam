/**
 * Partner figures (credits spec section 5, R3): one row per partner company (staff Partners tab)
 * or per month (the partner's own `/admin/partner`) from `v_partner_performance`: referred,
 * customers, revenue, commission accrued and paid, with a totals row. Aggregates only, never a
 * customer name. Pure presentation (no hooks), so server pages and the client tabs both render
 * it; the caller formats every amount and month in the page locale.
 */
import { EmptyState, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";

export type PartnerFigureRow = {
  key: string;
  /** Month ("November 2026") or partner company name, by the table's `firstColumn`. */
  label: string;
  referred: number;
  customers: number;
  revenueText: string;
  accruedText: string;
  paidText: string;
};

export type PartnerFiguresLabels = {
  caption: string;
  firstColumn: string;
  referred: string;
  customers: string;
  revenue: string;
  accrued: string;
  paid: string;
  total: string;
  empty: string;
};

export function PartnerFigures({ rows, totals, labels: l }: { rows: PartnerFigureRow[]; totals?: Omit<PartnerFigureRow, "key" | "label"> | null; labels: PartnerFiguresLabels }) {
  if (rows.length === 0) return <EmptyState title={l.empty} />;
  return (
    <Table>
      <TableCaption>{l.caption}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{l.firstColumn}</TableHead>
          <TableHead scope="col" className="text-right">
            {l.referred}
          </TableHead>
          <TableHead scope="col" className="text-right">
            {l.customers}
          </TableHead>
          <TableHead scope="col" className="text-right">
            {l.revenue}
          </TableHead>
          <TableHead scope="col" className="text-right">
            {l.accrued}
          </TableHead>
          <TableHead scope="col" className="text-right">
            {l.paid}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.key}>
            <TableCell>{r.label}</TableCell>
            <TableCell className="text-right tabular-nums">{r.referred}</TableCell>
            <TableCell className="text-right tabular-nums">{r.customers}</TableCell>
            <TableCell className="text-right tabular-nums">{r.revenueText}</TableCell>
            <TableCell className="text-right tabular-nums">{r.accruedText}</TableCell>
            <TableCell className="text-right tabular-nums">{r.paidText}</TableCell>
          </TableRow>
        ))}
        {totals ? (
          <TableRow className="font-semibold">
            <TableCell>{l.total}</TableCell>
            <TableCell className="text-right tabular-nums">{totals.referred}</TableCell>
            <TableCell className="text-right tabular-nums">{totals.customers}</TableCell>
            <TableCell className="text-right tabular-nums">{totals.revenueText}</TableCell>
            <TableCell className="text-right tabular-nums">{totals.accruedText}</TableCell>
            <TableCell className="text-right tabular-nums">{totals.paidText}</TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  );
}
