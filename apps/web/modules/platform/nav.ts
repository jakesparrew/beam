/**
 * Platform admin navigation (PL-19: an entry renders only when the user holds its permission).
 * Facade read by `pnpm gen:indexes`; `key` and `area` are literals.
 *
 * Entry contract read by the admin layout (every module's `nav.ts`):
 * - `section`: the sidebar group; its label is `platform.nav.section_<section>`.
 * - `permission?`: hidden unless the user holds it (`hasPermission`).
 * - `flag?`: hidden unless the flag is on for the user (`flag(key, actor)`, PL-43).
 * - `badge?`: `(input: { db, actor }) => Promise<number>`, a count shown next to the label when
 *   above 0 (for example open support requests). A failing or slow badge is left out.
 */
import { sql, type DbOrTx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";

async function openSupportCount({ db }: { db: DbOrTx }): Promise<number> {
  const [row] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from support_requests where status = 'open'`));
  return Number(row?.n ?? 0);
}

async function deadJobCount({ db }: { db: DbOrTx }): Promise<number> {
  const [row] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from jobs where status = 'dead'`));
  return Number(row?.n ?? 0);
}

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
    key: "platform.roles",
    area: "admin",
    section: "settings",
    labelKey: "platform.nav.roles",
    href: "/admin/settings/roles",
    permission: "users.manage",
    icon: "shield",
    order: 915,
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
    href: "/admin/system",
    permission: "system.jobs",
    icon: "server",
    order: 950,
  },
  {
    key: "platform.jobs",
    area: "admin",
    section: "system",
    labelKey: "platform.nav.jobs",
    href: "/admin/system/jobs",
    permission: "system.jobs",
    icon: "list",
    order: 952,
    badge: deadJobCount,
  },
  {
    key: "platform.support_register",
    area: "admin",
    section: "system",
    labelKey: "platform.nav.support_register",
    href: "/admin/system/support",
    permission: "system.jobs",
    icon: "life-buoy",
    order: 954,
    badge: openSupportCount,
  },
  {
    key: "platform.audit",
    area: "admin",
    section: "system",
    labelKey: "platform.nav.audit",
    href: "/admin/system/audit",
    permission: "system.jobs",
    icon: "scroll-text",
    order: 956,
  },
  {
    key: "platform.incidents",
    area: "admin",
    section: "system",
    labelKey: "platform.nav.incidents",
    href: "/admin/system/incidents",
    permission: "system.jobs",
    icon: "triangle-alert",
    order: 957,
  },
  {
    key: "platform.security",
    area: "admin",
    section: "system",
    labelKey: "platform.nav.security",
    href: "/admin/system/security",
    permission: "system.jobs",
    icon: "shield-check",
    order: 958,
  },
  {
    key: "platform.go_live",
    area: "admin",
    section: "system",
    labelKey: "platform.nav.go_live",
    href: "/admin/system/go-live",
    permission: "system.jobs",
    icon: "clipboard-list",
    order: 959,
  },
  {
    key: "platform.reports",
    area: "admin",
    section: "system",
    labelKey: "platform.nav.reports",
    href: "/admin/system/reports",
    permission: "system.jobs",
    icon: "file-text",
    order: 961,
  },
  {
    key: "platform.ai",
    area: "admin",
    section: "system",
    labelKey: "platform.nav.ai",
    href: "/admin/system/ai",
    permission: "ai.use",
    icon: "sparkles",
    order: 962,
  },
  {
    key: "platform.my_support",
    area: "admin",
    section: "help",
    labelKey: "platform.nav.my_support",
    href: "/admin/support",
    icon: "message-square",
    order: 990,
  },
] as const;
