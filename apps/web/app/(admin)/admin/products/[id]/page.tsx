import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@beam/ui";
import type { Audience } from "@beam/core/commerce";
import { formatDateTime, formatMoney, type LocalizedText } from "@beam/core/i18n";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { commerceLabels, getProduct, productFormOptions } from "@/modules/commerce/queries";
import { PriceHistory, type PriceHistoryRowView } from "@/modules/commerce/ui/price-history";
import { ProductActiveToggle, ProductForm } from "@/modules/commerce/ui/product-form";

const AUDIENCES: readonly Audience[] = ["public", "member", "b2b"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/admin/products/[id]` (`pricing.write`): the product form, activation and the price history (spec 5.1). */
export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff({ permission: "pricing.write" });
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const detail = await getProduct(await getAppDb(), id);
  if (!detail) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const { product: p, history } = detail;
  const labels = commerceLabels(locale, ["common", "admin_products"]);
  const priceLabels = { ...commerceLabels(locale, ["common", "admin_prices"]), invalid: tr("commerce.admin_products.invalid") };
  const missing = [...new Set([...detail.missing.name, ...detail.missing.description])];
  const fmt = (d: Date) => formatDateTime(d, locale, "short");
  const view = (a: Audience): PriceHistoryRowView[] =>
    history[a].map((r) => ({
      id: r.id,
      version: r.version,
      amount: formatMoney(r.amountCents, locale),
      window: r.validToAt
        ? tr("commerce.admin_prices.window_closed", { from: fmt(r.validFromAt), until: fmt(r.validToAt) })
        : tr("commerce.admin_prices.window_open", { from: fmt(r.validFromAt) }),
      reason: r.reason,
      by: r.createdByName ?? tr("commerce.admin_prices.seed"),
      isCurrent: r.isCurrent,
    }));
  const s = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
  const euros = (v: number | null) => (v === null ? "" : String(v / 100));

  return (
    <div className="grid gap-8">
      <Link href="/admin/products" className="text-sm underline-offset-4 hover:underline">
        {tr("commerce.admin_products.back_to_list")}
      </Link>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{(p.name as LocalizedText)[locale]?.trim() || p.sku}</h1>
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="font-mono">{p.sku}</span>
            <Badge variant="outline">{tr(`commerce.product_kind.${p.kind}`)}</Badge>
            <Badge variant={p.isActive ? "secondary" : "outline"}>{p.isActive ? tr("commerce.common.active") : tr("commerce.common.inactive")}</Badge>
          </p>
          {!p.isActive && missing.length ? <p className="text-sm text-destructive">{tr("commerce.admin_products.missing_before_activation", { locales: missing.join(", ") })}</p> : null}
        </div>
        <div className="flex flex-wrap items-start gap-3">
          <Link href={`/admin/products/${p.id}/person-prices`} className="text-sm underline-offset-4 hover:underline">
            {tr("commerce.admin_products.person_prices")}
          </Link>
          <ProductActiveToggle productId={p.id} isActive={p.isActive} labels={labels} />
        </div>
      </header>

      <ProductForm
        initial={{
          id: p.id,
          kind: p.kind,
          sku: p.sku,
          name: p.name,
          description: (p.description ?? {}),
          vatRatePct: String(Number(p.vatRatePct)),
          creditKind: p.creditKind ?? "",
          creditUnits: s(p.creditUnits),
          validityDays: s(p.validityDays),
          isSharingAllowed: p.isSharingAllowed,
          maxGuestUsesPerMonth: s(p.maxGuestUsesPerMonth),
          memberDiscountPct: p.memberDiscountPct === null ? "" : String(Number(p.memberDiscountPct)),
          recurringInterval: p.recurringInterval ?? "",
          includedCreditKind: p.includedCreditKind ?? "",
          includedCreditUnits: s(p.includedCreditUnits),
          itemCategory: p.itemCategory ?? "",
          isCustomAmount: p.isCustomAmount,
          minAmount: euros(p.minAmountCents),
          maxAmount: euros(p.maxAmountCents),
          isShopVisible: p.isShopVisible,
          isPosVisible: p.isPosVisible,
          sortOrder: String(p.sortOrder),
        }}
        options={productFormOptions(tr)}
        labels={labels}
      />

      {p.isCustomAmount ? null : (
        <PriceHistory
          productId={p.id}
          history={{ public: view("public"), member: view("member"), b2b: view("b2b") }}
          audiences={AUDIENCES.map((a) => ({ value: a, label: tr(`commerce.audience.${a}`) }))}
          canEdit
          labels={priceLabels}
        />
      )}
    </div>
  );
}
