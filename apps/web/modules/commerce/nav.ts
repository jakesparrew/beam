/**
 * commerce navigation (PL-19: an entry renders only when the user holds its permission). Facade read
 * by `pnpm gen:indexes`. commerce-P3 adds the catalogue screens; the orders and POS entries come
 * with their screens (commerce-P6, commerce-P7), so no entry links to a page that does not exist.
 * An entry has one permission: the catalogue entries use `pricing.write`; staff with only
 * `commerce.sell` reach the read-only product list from the POS and order screens.
 */
export const nav = [
  {
    key: "commerce.products",
    area: "admin",
    section: "sales",
    labelKey: "commerce.nav.products",
    href: "/admin/products",
    permission: "pricing.write",
    icon: "package",
    order: 320,
  },
  {
    key: "commerce.promotions",
    area: "admin",
    section: "sales",
    labelKey: "commerce.nav.promotions",
    href: "/admin/products/promotions",
    permission: "pricing.write",
    icon: "tag",
    order: 330,
  },
] as const;
