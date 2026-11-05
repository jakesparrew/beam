/**
 * email navigation (email spec section 5; PL-19: an entry renders only when the user holds its
 * permission). Facade read by `pnpm gen:indexes`. The "Email" group: email-P5 adds Templates;
 * email-P6 Campaigns; Overview and Messages come with email-P7's screens, so no entry links to a
 * page that does not exist yet.
 */
export const nav = [
  {
    key: "email.campaigns",
    area: "admin",
    section: "email",
    labelKey: "email.nav.campaigns",
    href: "/admin/campaigns",
    permission: "email.write",
    icon: "send",
    order: 410,
  },
  {
    key: "email.templates",
    area: "admin",
    section: "email",
    labelKey: "email.nav.templates",
    href: "/admin/templates",
    permission: "email.write",
    icon: "file-text",
    order: 420,
  },
] as const;
