import { randomUUID } from "node:crypto";
import { notFound, redirect } from "next/navigation";
import { localeFromSegment, URL_SEGMENT } from "@beam/core/i18n";
import { requireCustomer } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { checkOrderStatus, retryPayment } from "@/modules/commerce/actions";
import { getOrderForPayment, readViewer } from "@/modules/commerce/queries";
import { OrderReturn } from "@/modules/commerce/ui/basket";

/**
 * `/[locale]/account/checkout/return/[orderId]` (section 5.2): polls the order status every 2 s
 * for 30 s; paid shows what was granted, a failed payment the retry button, still open "Payment
 * pending, we will email you".
 */
export default async function AccountCheckoutReturnPage({ params, searchParams }: { params: Promise<{ locale: string; orderId: string }>; searchParams: Promise<{ payment?: string }> }) {
  const { locale: segment, orderId } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  const { payment } = await searchParams;
  const tr = translator(locale);
  const seg = URL_SEGMENT[locale];
  const order = await getOrderForPayment(await getAppDb(), orderId, await readViewer(actor), locale);
  if (!order) notFound();
  const id = order.orderId;
  const latest = order.payments.filter((p) => p.provider !== "credit_balance").at(-1) ?? null;

  async function poll() {
    "use server";
    return checkOrderStatus({ orderId: id });
  }
  async function retry() {
    "use server";
    const result = await retryPayment({ orderId: id, clientKey: randomUUID() });
    if (!result.ok) redirect(`/${seg}/account/checkout/${id}` as never);
    redirect(result.data.redirectUrl as never);
  }

  return (
    <OrderReturn
      locale={locale}
      reference={order.reference}
      initial={{ status: order.status, paymentStatus: latest?.status ?? null, dueCents: order.dueCents }}
      payment={payment ?? null}
      poll={poll}
      retryAction={order.status === "pending_payment" ? retry : null}
      links={[
        { href: `/${seg}/account/book`, label: tr("commerce.return.go_bookings") },
        { href: `/${seg}/account/orders/${id}`, label: tr("commerce.return.go_orders") },
      ]}
    />
  );
}
