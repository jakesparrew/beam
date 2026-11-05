import Link from "next/link";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { brusselsInputValue, commerceLabels, listProductOptions, listPromotionPartnerOptions, promotionFormOptions } from "@/modules/commerce/queries";
import { PromotionForm } from "@/modules/commerce/ui/promotion-form";

/** `/admin/products/promotions/new` (`pricing.write`): a code or an automatic offer (commerce spec 5.1); R3: a code can name a partner. */
export default async function NewPromotionPage() {
  await requireStaff({ permission: "pricing.write" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const [products, partners] = await Promise.all([listProductOptions(db), listPromotionPartnerOptions(db)]);
  return (
    <div className="grid gap-6">
      <Link href="/admin/products/promotions" className="text-sm underline-offset-4 hover:underline">
        {tr("commerce.admin_promotions.back_to_list")}
      </Link>
      <h1 className="text-2xl font-semibold">{tr("commerce.admin_promotions.new_title")}</h1>
      <PromotionForm
        initial={{
          code: "",
          name: {},
          kind: "percent",
          value: "10",
          productIds: [],
          productKinds: [],
          statuses: [],
          channels: [],
          segmentId: "",
          firstOrderOnly: false,
          startsAt: brusselsInputValue(new Date()),
          endsAt: "",
          maxUses: "",
          maxUsesPerPerson: "",
          isActive: true,
          partnerCompanyId: "",
        }}
        usesCount={0}
        options={{ ...promotionFormOptions(tr, locale, products), partners }}
        labels={{ ...commerceLabels(locale, ["common", "admin_promotions"]), invalid: tr("commerce.admin_products.invalid") }}
      />
    </div>
  );
}
