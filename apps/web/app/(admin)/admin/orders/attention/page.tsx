import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { formatDateTime, formatMoney } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { ATTENTION_KINDS, getAttentionFeed, groupAttention } from "@/modules/commerce/queries";

/**
 * `/admin/orders/attention` (commerce spec 5.1; `commerce.sell` or `reports.read`): the
 * `v_payment_attention` feed grouped by kind with the age of each problem; the same list feeds
 * ops' action dashboard (`listPaymentAttention`). Each row opens its order, where the payment link,
 * Retry and cancellation live.
 */
export default async function AttentionPage() {
  const actor = await requireStaff();
  if (!hasPermission(actor, "commerce.sell") && !hasPermission(actor, "reports.read")) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const c = (k: string, p?: Record<string, string | number>) => tr(`commerce.admin_attention.${k}`, p);
  const rows = await getAttentionFeed(await getAppDb(), { limit: 500 });
  const grouped = groupAttention(rows);

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{c("title")}</h1>
        <Link href="/admin/orders" className="text-sm underline">
          {tr("commerce.admin_orders.back")}
        </Link>
      </header>
      {rows.length === 0 ? (
        <EmptyState title={c("empty")} />
      ) : (
        ATTENTION_KINDS.filter((k) => grouped[k].length > 0).map((kind) => (
          <section key={kind} aria-labelledby={`kind-${kind}`} className="grid gap-2">
            <h2 id={`kind-${kind}`} className="text-lg font-semibold">
              {c(`kind_${kind}`)} ({grouped[kind].length})
            </h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{c("col_order")}</TableHead>
                  <TableHead>{c("col_customer")}</TableHead>
                  <TableHead className="text-right">{c("col_amount")}</TableHead>
                  <TableHead>{c("col_since")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {grouped[kind].map((r) => (
                  <TableRow key={`${r.kind}-${r.paymentId}`}>
                    <TableCell>
                      <Link href={`/admin/orders/${r.orderId}`} className="underline" aria-label={c("open", { reference: r.reference })}>
                        {r.reference}
                      </Link>
                    </TableCell>
                    <TableCell>{r.personName ?? tr("commerce.admin_orders.walk_in")}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(r.amountCents, locale)}</TableCell>
                    <TableCell>{formatDateTime(r.since, locale, "short")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        ))
      )}
    </div>
  );
}
