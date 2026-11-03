/**
 * Platform admin navigation (PL-19: an entry renders only when the user holds its permission).
 * Facade read by `pnpm gen:indexes`. The screens are platform-P6 (jobs) and platform-P8.
 */
export const nav = [
  {
    key: "platform.settings",
    area: "admin",
    section: "settings",
    labelKey: "platform.nav.settings",
    href: "/admin/settings",
    permission: "settings.write",
    icon: "settings",
    order: 900,
  },
  {
    key: "platform.users",
    area: "admin",
    section: "settings",
    labelKey: "platform.nav.users",
    href: "/admin/settings/users",
    permission: "users.manage",
    icon: "users",
    order: 910,
  },
  {
    key: "platform.flags",
    area: "admin",
    section: "settings",
    labelKey: "platform.nav.flags",
    href: "/admin/settings/flags",
    permission: "flags.manage",
    icon: "flag",
    order: 920,
  },
  {
    key: "platform.system",
    area: "admin",
    section: "system",
    labelKey: "platform.nav.system",
    href: "/admin/system/jobs",
    permission: "system.jobs",
    icon: "server",
    order: 950,
  },
  {
    key: "platform.ai",
    area: "admin",
    section: "system",
    labelKey: "platform.nav.ai",
    href: "/admin/system/ai",
    permission: "ai.use",
    icon: "sparkles",
    order: 960,
  },
] as const;
