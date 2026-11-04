import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDateTime, formatMoney, type LocalizedText } from "@beam/core/i18n";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { commerceLabels, getProduct, listPersonPrices } from "@/modules/commerce/queries";
import { PersonPricePanel } from "@/modules/commerce/ui/price-history";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/admin/products/[id]/person-prices` (`pricing.write`): customer-specific prices, add and revoke (rule 6). */
export default async function PersonPricesPage({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff({ permission: "pricing.write" });
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getAppDb();
  const detail = await getProduct(db, id);
  if (!detail) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const fmt = (d: Date) => formatDateTime(d, locale, "short");
  const rows = (await listPersonPrices(db, id)).map((r) => ({
    id: r.id,
    person: r.personEmail ? `${r.personName} (${r.personEmail})` : r.personName,
    amount: formatMoney(r.amountCents, locale),
    window: r.validToAt
      ? tr("commerce.admin_prices.window_closed", { from: fmt(r.validFromAt), until: fmt(r.validToAt) })
      : tr("commerce.admin_prices.window_open", { from: fmt(r.validFromAt) }),
    reason: r.reason,
    isRevoked: r.revokedAt !== null,
  }));
  const name = (detail.product.name as LocalizedText)[locale]?.trim() || detail.product.sku;

  return (
    <div className="grid gap-6">
      <Link href={`/admin/products/${id}`} className="text-sm underline-offset-4 hover:underline">
        {name}
      </Link>
      <h1 className="text-2xl font-semibold">{tr("commerce.admin_prices.person_title")}</h1>
      <PersonPricePanel
        productId={id}
        rows={rows}
        canEdit
        labels={{ ...commerceLabels(locale, ["common", "admin_prices"]), invalid: tr("commerce.admin_products.invalid") }}
      />
    </div>
  );
}
