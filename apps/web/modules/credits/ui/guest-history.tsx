/**
 * Guests of a package (credits spec section 5, blueprint 49 "guest attendance history"): each
 * guest with their uses, last use and the attendance of every use, linked to the guest's person
 * page (staff see full names, rule 38). Server component.
 */
import Link from "next/link";
import { Badge, EmptyState, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { formatDate, formatDateTime, type Locale } from "@beam/core/i18n";
import { translator } from "@/lib/i18n";
import type { GuestRow } from "../queries";

export function GuestHistory({ guests, locale }: { guests: GuestRow[]; locale: Locale }) {
  const tr = translator(locale);
  const g = (k: string) => tr(`credits.admin.grant.${k}`);
  if (guests.length === 0) return <EmptyState title={g("guests_empty")} />;
  return (
    <Table>
      <TableCaption>{g("guests_caption")}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>{g("col_guest")}</TableHead>
          <TableHead className="text-right">{g("col_uses")}</TableHead>
          <TableHead>{g("col_last_use")}</TableHead>
          <TableHead>{g("col_history")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {guests.map((guest) => (
          <TableRow key={guest.personId}>
            <TableCell>
              <Link href={`/admin/persons/${guest.personId}`} className="font-medium hover:underline">
                {guest.name || tr("credits.admin.common.none")}
              </Link>
            </TableCell>
            <TableCell className="text-right tabular-nums">{guest.uses}</TableCell>
            <TableCell>{formatDate(guest.lastUsedAt, locale, "medium")}</TableCell>
            <TableCell>
              <ul className="flex flex-wrap gap-1">
                {guest.attendance.map((a, i) => (
                  <li key={i}>
                    <Badge variant="outline">
                      {a.sessionStartsAt ? `${formatDateTime(a.sessionStartsAt, locale, "short")} · ` : ""}
                      {a.attendance ? tr(`credits.enum.attendance.${a.attendance}`) : tr("credits.admin.common.none")}
                    </Badge>
                  </li>
                ))}
              </ul>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
