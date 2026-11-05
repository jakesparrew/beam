/**
 * email navigation (email spec section 5; PL-19: an entry renders only when the user holds its
 * permission). Facade read by `pnpm gen:indexes`. The "Email" group: email-P5 adds Templates;
 * email-P6 Campaigns; email-P7 Overview and Messages. The overview opens with `email.write` or
 * `reports.read`; an entry carries one permission, so it uses `reports.read`, which every default
 * role with `email.write` also holds (marketing, customer service, owner, management).
 */
export const nav = [
  {
    key: "email.overview",
    area: "admin",
    section: "email",
    labelKey: "email.nav.overview",
    href: "/admin/email",
    permission: "reports.read",
    icon: "mail",
    order: 400,
  },
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
  {
    key: "email.messages",
    area: "admin",
    section: "email",
    labelKey: "email.nav.messages",
    href: "/admin/email/messages",
    permission: "email.write",
    icon: "inbox",
    order: 430,
  },
] as const;
