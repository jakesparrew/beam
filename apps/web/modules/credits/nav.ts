/**
 * credits navigation (credits spec section 5; PL-19: an entry renders only when the user holds its
 * permission, the same permission that guards the page). Facade read by `pnpm gen:indexes`.
 * credits-P6 adds "Packages" and "Memberships" under Customers. `/admin/memberships` also opens
 * for `memberships.write` alone; an entry has one permission, so the entry uses `credits.read`,
 * which every role with `memberships.write` holds. The portal entries come with credits-P7.
 */
export const nav = [
  {
    key: "credits.packages",
    area: "admin",
    section: "customers",
    labelKey: "credits.nav.packages",
    href: "/admin/credits",
    permission: "credits.read",
    icon: "credit-card",
    order: 260,
  },
  {
    key: "credits.memberships",
    area: "admin",
    section: "customers",
    labelKey: "credits.nav.memberships",
    href: "/admin/memberships",
    permission: "credits.read",
    icon: "user-cog",
    order: 270,
  },
] as const;
