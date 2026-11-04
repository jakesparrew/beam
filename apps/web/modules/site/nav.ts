/**
 * site navigation (PL-19: an entry renders only when the user holds its permission). Facade read
 * by `pnpm gen:indexes`. The admin group "Website" (`site.edit`, screens from site-P3) and the one
 * customer entry `account` (Home, order 0; the portal home from site-P6).
 */
export const nav = [
  {
    key: "site.website",
    area: "admin",
    section: "website",
    labelKey: "site.admin.nav.website",
    href: "/admin/site",
    permission: "site.edit",
    icon: "globe",
    order: 700,
  },
  {
    key: "site.account",
    area: "portal",
    labelKey: "site.portal.nav.home",
    href: "/account",
    icon: "home",
    order: 0,
  },
] as const;
