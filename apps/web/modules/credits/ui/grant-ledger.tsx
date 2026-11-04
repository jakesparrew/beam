/**
 * The ledger table of `/admin/credits/grants/[grantId]` (credits spec section 5): date, movement,
 * units, running balance, beneficiary, booking and session, attendance, actor and reason. Staff
 * see every actor and reason (rule 39). Server component.
 */
import Link from "next/link";
import { Badge, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { formatDateTime, formatMoney, type Locale } from "@beam/core/i18n";
import { translator } from "@/lib/i18n";
import type { LedgerRow } from "../queries";

export function GrantLedger({ entries, kind, ownerPersonId, locale }: { entries: LedgerRow[]; kind: string; ownerPersonId: string; locale: Locale }) {
  const tr = translator(locale);
  const g = (k: string) => tr(`credits.admin.grant.${k}`);
  const none = tr("credits.admin.common.none");
  const amount = (n: number) => (kind === "euro" ? formatMoney(n, locale) : String(n));
  const signed = (n: number) => (n > 0 ? `+${amount(n)}` : n < 0 ? `−${amount(-n)}` : amount(0));
  return (
    <Table>
      <TableCaption>{g("ledger_caption")}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>{g("col_date")}</TableHead>
          <TableHead>{g("col_kind")}</TableHead>
          <TableHead className="text-right">{g("col_quantity")}</TableHead>
          <TableHead className="text-right">{g("col_balance")}</TableHead>
          <TableHead>{g("col_beneficiary")}</TableHead>
          <TableHead>{g("col_session")}</TableHead>
          <TableHead>{g("col_attendance")}</TableHead>
          <TableHead>{g("col_actor")}</TableHead>
          <TableHead>{g("col_reason")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((e) => (
          <TableRow key={e.entryId}>
            <TableCell className="whitespace-nowrap">{formatDateTime(e.createdAt, locale, "short")}</TableCell>
            <TableCell>
              {tr(`credits.enum.entry_kind.${e.kind}`)}
              {e.isReleased ? <span className="ml-1 text-xs text-muted-foreground">({g("returned")})</span> : null}
            </TableCell>
            <TableCell className="text-right tabular-nums">{signed(e.quantity)}</TableCell>
            <TableCell className="text-right tabular-nums">{amount(e.runningBalance)}</TableCell>
            <TableCell>
              {e.beneficiaryPersonId ? (
                e.beneficiaryPersonId === ownerPersonId ? (
                  <span>{e.beneficiaryName || none}</span>
                ) : (
                  <Link href={`/admin/persons/${e.beneficiaryPersonId}`} className="hover:underline">
                    {e.beneficiaryName || none}
                  </Link>
                )
              ) : (
                none
              )}
            </TableCell>
            <TableCell>
              {e.bookingId ? (
                <span>
                  {e.sessionTitle?.[locale] ?? none}
                  {e.sessionStartsAt ? <span className="block text-xs text-muted-foreground">{formatDateTime(e.sessionStartsAt, locale, "short")}</span> : null}
                </span>
              ) : (
                none
              )}
            </TableCell>
            <TableCell>{e.attendance ? <Badge variant="outline">{tr(`credits.enum.attendance.${e.attendance}`)}</Badge> : none}</TableCell>
            <TableCell>{e.actorName ?? tr(`credits.enum.actor.${e.actorKind}`)}</TableCell>
            <TableCell className="max-w-64 whitespace-pre-wrap break-words text-sm">{e.reason ?? none}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
