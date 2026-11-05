/**
 * credits navigation (credits spec section 5; PL-19: an entry renders only when the user holds its
 * permission, the same permission that guards the page). Facade read by `pnpm gen:indexes`.
 * credits-P6 adds "Packages" and "Memberships" under Customers. `/admin/memberships` also opens
 * for `memberships.write` alone; an entry has one permission, so the entry uses `credits.read`,
 * which every role with `memberships.write` holds. credits-P9 adds the R2 "Sharing review"
 * (credits-P8 request), the R3 "Referrals" (`referrals.manage`; `reports.read` alone opens the page
 * by URL) and the portal "Invite a friend". `/admin/partner` is platform's `platform.partner` entry.
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
  {
    key: "credits.sharing_review",
    area: "admin",
    section: "customers",
    labelKey: "credits.nav.sharing_review",
    href: "/admin/credits/sharing-review",
    permission: "credits.read",
    icon: "shield",
    order: 275,
  },
  {
    key: "credits.referrals",
    area: "admin",
    section: "sales",
    labelKey: "credits.nav.referrals",
    href: "/admin/referrals",
    permission: "referrals.manage",
    icon: "gift",
    order: 280,
  },
  {
    key: "credits.my_referrals",
    area: "portal",
    section: "account",
    labelKey: "credits.nav.my_referrals",
    href: "/account/referrals",
    icon: "gift",
    order: 60,
  },
] as const;
