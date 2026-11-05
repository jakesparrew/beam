/**
 * commerce navigation (PL-19: an entry renders only when the user holds its permission). Facade read
 * by `pnpm gen:indexes`. commerce-P3 adds the catalogue screens; the orders and POS entries come
 * with their screens (commerce-P6, commerce-P7), so no entry links to a page that does not exist.
 * An entry has one permission: the catalogue entries use `pricing.write`; staff with only
 * `commerce.sell` reach the read-only product list from the POS and order screens. commerce-P6 adds
 * the orders list and the payment attention feed (`commerce.sell`). commerce-P7 adds the front-desk
 * POS and its day close (`commerce.sell`). commerce-P9 (R3) adds the Lightspeed import
 * (`commerce.sell`, the staff who upload the daily export; `reports.finance` without
 * `commerce.sell` reaches the page from the finance reports).
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
  {
    key: "commerce.orders",
    area: "admin",
    section: "sales",
    labelKey: "commerce.nav.orders",
    href: "/admin/orders",
    permission: "commerce.sell",
    icon: "receipt",
    order: 300,
  },
  {
    key: "commerce.attention",
    area: "admin",
    section: "sales",
    labelKey: "commerce.nav.attention",
    href: "/admin/orders/attention",
    permission: "commerce.sell",
    icon: "alert-triangle",
    order: 310,
  },
  {
    key: "commerce.pos",
    area: "admin",
    section: "sales",
    labelKey: "commerce.nav.pos",
    href: "/admin/pos",
    permission: "commerce.sell",
    icon: "shopping-cart",
    order: 290,
  },
  {
    key: "commerce.pos_day",
    area: "admin",
    section: "sales",
    labelKey: "commerce.nav.pos_day",
    href: "/admin/pos/day",
    permission: "commerce.sell",
    icon: "banknote",
    order: 295,
  },
  {
    key: "commerce.lightspeed",
    area: "admin",
    section: "sales",
    labelKey: "commerce.nav.lightspeed",
    href: "/admin/pos/lightspeed",
    permission: "commerce.sell",
    icon: "upload",
    order: 297,
  },
] as const;
