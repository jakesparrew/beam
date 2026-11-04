/**
 * `UsageHistory` (credits spec section 5, `/[locale]/account/packages/[grantId]`): the customer's
 * usage lines of one package, newest first: date, session title or what happened ("Returned on
 * cancellation", "Expired", "Adjusted by BEAM", "Extended by BEAM until …"), who used it ("You"
 * or a guest's first name and initial, rule 38) and the attendance as a text badge. Staff reasons
 * and actors never reach this component (rule 37). `StoreCreditOrders` lists the orders a euro
 * balance paid. Server components; strings from the catalogue.
 */
import { Badge, EmptyState } from "@beam/ui";
import { formatDate, formatMoney, type Locale } from "@beam/core/i18n";
import type { CreditKind } from "@beam/core/credits";
import { translator } from "@/lib/i18n";
import type { Attendance, MyPackageDetail, MyUsageRow } from "../queries";

type Tr = ReturnType<typeof translator>;

const ATTENDANCE_GLYPH: Record<Attendance, string> = { upcoming: "◷", attended: "✓", no_show: "✕", cancelled: "↺", late_cancelled: "↺" };

export function AttendanceBadge({ attendance, locale }: { attendance: Attendance; locale: Locale }) {
  const tr = translator(locale);
  const variant = attendance === "attended" ? "success" : attendance === "no_show" ? "warning" : "outline";
  return (
    <Badge variant={variant} data-attendance={attendance}>
      <span aria-hidden="true">{ATTENDANCE_GLYPH[attendance]}</span>
      {tr(`credits.portal.attendance.${attendance}`)}
    </Badge>
  );
}

/** The "What" cell of a usage line. */
export function usageWhat(row: MyUsageRow, locale: Locale, tr: Tr = translator(locale)): string {
  switch (row.kind) {
    case "use": {
      const title = row.sessionTitle?.[locale];
      return typeof title === "string" && title.trim() ? title : tr("credits.portal.package.used");
    }
    case "returned":
      return tr("credits.portal.package.returned");
    case "expired":
      return tr("credits.portal.package.expired");
    case "adjusted":
      return tr("credits.portal.package.adjusted_by_beam");
    case "extended":
      return row.newExpiresAt ? tr("credits.portal.package.extended_by_beam", { date: formatDate(row.newExpiresAt, locale) }) : tr("credits.portal.package.adjusted_by_beam");
    case "revoked":
      return tr("credits.portal.package.revoked");
    case "transferred":
      return tr("credits.portal.package.transferred");
  }
}

/** "You" or "Anna D. (guest)". */
export function usedByText(row: MyUsageRow, locale: Locale, tr: Tr = translator(locale)): string {
  if (!row.usedBy) return "";
  return row.usedBy.you ? tr("credits.portal.package.used_by_you") : tr("credits.portal.package.used_by_guest", { name: row.usedBy.name });
}

function change(kind: CreditKind, quantity: number, locale: Locale): string {
  if (quantity === 0) return "";
  const sign = quantity > 0 ? "+" : "−";
  return kind === "euro" ? `${sign}${formatMoney(Math.abs(quantity), locale)}` : `${sign}${Math.abs(quantity)}`;
}

export function UsageHistory({ detail, locale }: { detail: MyPackageDetail; locale: Locale }) {
  const tr = translator(locale);
  const rows = detail.usage;
  if (rows.length === 0) return <EmptyState title={tr("credits.portal.package.empty")} />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{tr("credits.portal.package.caption")}</caption>
        <thead>
          <tr className="border-b text-left">
            <th scope="col" className="py-2 pr-3 font-medium">{tr("credits.portal.package.col_date")}</th>
            <th scope="col" className="py-2 pr-3 font-medium">{tr("credits.portal.package.col_what")}</th>
            <th scope="col" className="py-2 pr-3 font-medium">{tr("credits.portal.package.col_used_by")}</th>
            <th scope="col" className="py-2 pr-3 font-medium">{tr("credits.portal.package.col_status")}</th>
            <th scope="col" className="py-2 text-right font-medium">{tr("credits.portal.package.col_units")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.entryId} className="border-b last:border-0" data-testid="usage-row" data-kind={r.kind}>
              <td className="py-2 pr-3 whitespace-nowrap">{formatDate(r.kind === "use" && r.sessionStartsAt ? r.sessionStartsAt : r.at, locale)}</td>
              <td className="py-2 pr-3">{usageWhat(r, locale, tr)}</td>
              <td className="py-2 pr-3">{usedByText(r, locale, tr)}</td>
              <td className="py-2 pr-3">{r.attendance ? <AttendanceBadge attendance={r.attendance} locale={locale} /> : null}</td>
              <td className="py-2 text-right tabular-nums">{change(detail.package.kind, r.quantity, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Store credit: the orders this balance paid (date, order reference, amount). */
export function StoreCreditOrders({ detail, locale }: { detail: MyPackageDetail; locale: Locale }) {
  const tr = translator(locale);
  if (detail.orders.length === 0) return null;
  return (
    <section aria-labelledby="store-credit-orders" className="grid gap-2">
      <h2 id="store-credit-orders" className="text-lg font-semibold">
        {tr("credits.portal.package.orders_title")}
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">{tr("credits.portal.package.orders_caption")}</caption>
          <thead>
            <tr className="border-b text-left">
              <th scope="col" className="py-2 pr-3 font-medium">{tr("credits.portal.package.col_date")}</th>
              <th scope="col" className="py-2 pr-3 font-medium">{tr("credits.portal.package.col_order")}</th>
              <th scope="col" className="py-2 text-right font-medium">{tr("credits.portal.package.col_amount")}</th>
            </tr>
          </thead>
          <tbody>
            {detail.orders.map((o) => (
              <tr key={`${o.orderId}:${o.at.toISOString()}`} className="border-b last:border-0">
                <td className="py-2 pr-3">{formatDate(o.at, locale)}</td>
                <td className="py-2 pr-3">{o.reference}</td>
                <td className="py-2 text-right tabular-nums">{formatMoney(o.amountCents, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
