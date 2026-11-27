import { notFound, redirect } from "next/navigation";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getAttentionFeed } from "@/modules/commerce/queries";
import { PageHeader } from "@/modules/platform/ui/admin-kit";
import { AttentionTable } from "../attention-table";

/**
 * `/admin/orders/attention` (commerce spec 5.1; `commerce.sell` or `reports.read`): the
 * `v_payment_attention` feed; the same list feeds ops' action dashboard (`listPaymentAttention`).
 * Since the owner review (November 2026) it is the "Op te volgen" tab of `/admin/orders`, so staff
 * who may open the orders list go there; staff with only `reports.read` keep this page.
 */
export default async function AttentionPage() {
  const actor = await requireStaff();
  if (!hasPermission(actor, "commerce.sell") && !hasPermission(actor, "reports.read")) notFound();
  if (["commerce.sell", "commerce.refund", "invoices.read"].some((p) => hasPermission(actor, p as "commerce.sell"))) redirect("/admin/orders?status=attention");
  const locale = await adminLocale();
  const tr = translator(locale);
  const rows = await getAttentionFeed(await getAppDb(), { limit: 500 });

  return (
    <div className="grid gap-4">
      <PageHeader title={tr("commerce.admin_attention.title")} description={tr("commerce.admin_attention.subtitle")} />
      <AttentionTable rows={rows} locale={locale} tr={tr} />
    </div>
  );
}
