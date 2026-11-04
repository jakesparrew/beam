/**
 * automation navigation (automation spec 5; PL-19: an entry renders only when the user holds its
 * permission). Facade read by `pnpm gen:indexes`. The list screen opens with `automations.write`
 * or `reports.read`; an entry carries one permission, so it uses `reports.read`, which every
 * default role with `automations.write` also holds (owner, technical_admin, management,
 * marketing). Groups are reached from the list screen.
 */
export const nav = [
  {
    key: "automation.automations",
    area: "admin",
    section: "marketing",
    labelKey: "automation.nav.automations",
    href: "/admin/automations",
    permission: "reports.read",
    icon: "workflow",
    order: 420,
  },
] as const;
