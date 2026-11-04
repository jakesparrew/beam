import Link from "next/link";
import { requireStaff } from "@/lib/auth";
import { adminLocale, translator } from "@/lib/i18n";
import { commerceLabels, productFormOptions } from "@/modules/commerce/queries";
import { ProductForm } from "@/modules/commerce/ui/product-form";

/** `/admin/products/new` (`pricing.write`), commerce spec 5.1. The product starts inactive (rule 1). */
export default async function NewProductPage() {
  await requireStaff({ permission: "pricing.write" });
  const locale = await adminLocale();
  const tr = translator(locale);
  return (
    <div className="grid gap-6">
      <Link href="/admin/products" className="text-sm underline-offset-4 hover:underline">
        {tr("commerce.admin_products.back_to_list")}
      </Link>
      <h1 className="text-2xl font-semibold">{tr("commerce.admin_products.new_title")}</h1>
      <ProductForm
        initial={{
          kind: "package",
          sku: "",
          name: {},
          description: {},
          vatRatePct: "21",
          creditKind: "day",
          creditUnits: "",
          validityDays: "",
          isSharingAllowed: false,
          maxGuestUsesPerMonth: "2",
          memberDiscountPct: "",
          recurringInterval: "month",
          includedCreditKind: "",
          includedCreditUnits: "",
          itemCategory: "merchandise",
          isCustomAmount: false,
          minAmount: "",
          maxAmount: "",
          isShopVisible: false,
          isPosVisible: true,
          sortOrder: "0",
        }}
        options={productFormOptions(tr)}
        labels={commerceLabels(locale, ["common", "admin_products"])}
      />
    </div>
  );
}
