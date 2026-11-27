import { Segmented } from "@/modules/platform/ui/admin-kit";

/** Producten | Promoties at the right of both catalogue toolbars (owner review, November 2026). */
export function CatalogueSwitch({ active, tr }: { active: "products" | "promotions"; tr: (key: string) => string }) {
  return (
    <div className="ml-auto">
      <Segmented
        label={tr("commerce.admin_products.catalogue")}
        items={[
          { key: "products", label: tr("commerce.nav.products"), href: "/admin/products", active: active === "products" },
          { key: "promotions", label: tr("commerce.nav.promotions"), href: "/admin/products/promotions", active: active === "promotions" },
        ]}
      />
    </div>
  );
}
