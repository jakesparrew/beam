/**
 * assistant navigation. Facade read by `pnpm gen:indexes`: `key` and `area` are literals. The admin
 * layout gives section `assistant` a group of its own (overview first, then the sub-pages).
 */
export const nav = [
  { key: "assistant.overview", area: "admin", section: "assistant", labelKey: "assistant.nav.overview", href: "/admin/assistant", permission: "assistant.read", icon: "sparkles", order: 10 },
  { key: "assistant.conversations", area: "admin", section: "assistant", labelKey: "assistant.nav.conversations", href: "/admin/assistant/conversations", permission: "assistant.read", icon: "messages-square", order: 20 },
  { key: "assistant.eval", area: "admin", section: "assistant", labelKey: "assistant.nav.eval", href: "/admin/assistant/eval", permission: "assistant.manage", icon: "flask-conical", order: 30 },
  { key: "assistant.settings", area: "admin", section: "assistant", labelKey: "assistant.nav.settings", href: "/admin/assistant/settings", permission: "assistant.manage", icon: "sliders-horizontal", order: 40 },
] as const;
