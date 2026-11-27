import Link from "next/link";
import { cn, EmptyState } from "@beam/ui";
import { formatDateTime, formatMoney, type Locale } from "@beam/core/i18n";
import type { AttentionKind, AttentionRow } from "@/modules/commerce/queries";
import { StatusPill, Surface, td, th, type Tone } from "@/modules/platform/ui/admin-kit";
import { Initials, rowClass, rowLink } from "@/modules/platform/ui/admin-list-kit";

const KIND_TONE: Record<AttentionKind, Tone> = { payment_failed: "bad", payment_pending_15m: "warn", bank_transfer_overdue: "warn", refund_failed: "bad", chargeback: "bad" };

/**
 * The payment follow-up feed (`v_payment_attention`, commerce spec 5.1) as one table: the order,
 * the customer, the problem as a pill, the amount and since when. Each row opens its order, where
 * the payment link, Retry and cancellation live. Shown by `/admin/orders?status=attention` ("Op te
 * volgen") and by `/admin/orders/attention` for staff who only hold `reports.read`.
 */
export function AttentionTable({ rows, locale, tr }: { rows: readonly AttentionRow[]; locale: Locale; tr: (key: string, params?: Record<string, string | number>) => string }) {
  const c = (k: string, p?: Record<string, string | number>) => tr(`commerce.admin_attention.${k}`, p);
  if (rows.length === 0) return <EmptyState title={c("empty")} />;
  return (
    <Surface flush data-testid="orders-attention">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] text-[0.8125rem]">
          <caption className="sr-only">{c("title")}</caption>
          <thead className="bg-[#faf9f6]">
            <tr className="border-b border-border">
              <th scope="col" className={cn(th, "w-40")}>{c("col_order")}</th>
              <th scope="col" className={th}>{c("col_customer")}</th>
              <th scope="col" className={cn(th, "w-60")}>{c("col_problem")}</th>
              <th scope="col" className={cn(th, "w-28 text-right")}>{c("col_amount")}</th>
              <th scope="col" className={cn(th, "w-40")}>{c("col_since")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.kind}-${r.paymentId}`} className={rowClass} data-kind={r.kind}>
                <td className={cn(td, "font-semibold whitespace-nowrap")}>
                  <Link href={`/admin/orders/${r.orderId}`} className={cn(rowLink, "hover:underline")} aria-label={c("open", { reference: r.reference })}>
                    {r.reference}
                  </Link>
                  <span className="block text-[0.75rem] font-normal text-muted-foreground">{tr(`commerce.channel.${r.channel}`)}</span>
                </td>
                <td className={td}>
                  <span className="flex items-center gap-2.5">
                    <Initials name={r.personName} />
                    <span className="grid leading-tight">
                      <span className="font-medium">{r.personName ?? tr("commerce.admin_orders.walk_in")}</span>
                      {r.personEmail && r.personEmail !== r.personName ? <span className="text-[0.75rem] text-muted-foreground">{r.personEmail}</span> : null}
                    </span>
                  </span>
                </td>
                <td className={td}>
                  <StatusPill tone={KIND_TONE[r.kind]}>{c(`kind_${r.kind}`)}</StatusPill>
                </td>
                <td className={cn(td, "text-right font-semibold whitespace-nowrap tabular-nums")}>{formatMoney(r.amountCents, locale)}</td>
                <td className={cn(td, "whitespace-nowrap text-muted-foreground")}>{formatDateTime(r.since, locale, "short")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Surface>
  );
}
