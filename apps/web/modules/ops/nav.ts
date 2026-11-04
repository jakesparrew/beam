/**
 * ops navigation (ops spec 5; PL-19: an entry renders only when the user holds its permission,
 * the same permission that guards the page). Facade read by `pnpm gen:indexes`: `key` and `area`
 * are literals. Written once by ops-P1 with every screen of section 5; the pages land with
 * ops-P3 (dashboard, reports), P4 (imports), P5 (privacy), P6 (exports, retention policies,
 * DPIA), P7-P10 (R2-R4 screens). `flag` names the release flag that hides an entry until its
 * release (`ff_ops_retention` R2, `ff_ops_marketing` R3, `ff_ops_ai` R4); the shell reads it once
 * it filters on flags, and the pages check it themselves.
 *
 * Sections: `insights` (dashboards), `reports`, `data` (imports, exports, privacy).
 */
export const nav = [
  // Insights
  { key: "ops.dashboard", area: "admin", section: "insights", labelKey: "ops.nav.dashboard", href: "/admin/dashboard", permission: "reports.read", icon: "layout-dashboard", order: 10 },
  { key: "ops.retention", area: "admin", section: "insights", labelKey: "ops.nav.retention", href: "/admin/dashboard/retention", permission: "reports.read", flag: "ff_ops_retention", icon: "repeat", order: 11 },
  { key: "ops.pipeline", area: "admin", section: "insights", labelKey: "ops.nav.pipeline", href: "/admin/dashboard/pipeline", permission: "reports.read", flag: "ff_ops_retention", icon: "workflow", order: 12 },
  { key: "ops.management", area: "admin", section: "insights", labelKey: "ops.nav.management", href: "/admin/dashboard/management", permission: "reports.read", flag: "ff_ops_marketing", icon: "chart-line", order: 13 },
  { key: "ops.custom", area: "admin", section: "insights", labelKey: "ops.nav.custom", href: "/admin/dashboard/custom", permission: "reports.read", flag: "ff_ops_ai", icon: "layers", order: 14 },
  { key: "ops.ask", area: "admin", section: "insights", labelKey: "ops.nav.ask", href: "/admin/dashboard/ask", permission: "ai.use", flag: "ff_ops_ai", icon: "sparkles", order: 15 },
  { key: "ops.summary", area: "admin", section: "insights", labelKey: "ops.nav.summary", href: "/admin/dashboard/summary", permission: "reports.read", flag: "ff_ops_ai", icon: "newspaper", order: 16 },
  // Reports
  { key: "ops.reports", area: "admin", section: "reports", labelKey: "ops.nav.reports", href: "/admin/reports", permission: "reports.read", icon: "chart-bar", order: 600 },
  { key: "ops.reports_revenue", area: "admin", section: "reports", labelKey: "ops.nav.reports_revenue", href: "/admin/reports/revenue", permission: "reports.read", icon: "euro", order: 610 },
  { key: "ops.reports_no_shows", area: "admin", section: "reports", labelKey: "ops.nav.reports_no_shows", href: "/admin/reports/no-shows", permission: "reports.read", flag: "ff_ops_retention", icon: "calendar-check", order: 620 },
  { key: "ops.reports_abandoned", area: "admin", section: "reports", labelKey: "ops.nav.reports_abandoned", href: "/admin/reports/abandoned-checkouts", permission: "reports.read", flag: "ff_ops_retention", icon: "shopping-cart", order: 630 },
  { key: "ops.reports_capacity", area: "admin", section: "reports", labelKey: "ops.nav.reports_capacity", href: "/admin/reports/capacity", permission: "reports.read", flag: "ff_ops_retention", icon: "users", order: 640 },
  { key: "ops.reports_marketing", area: "admin", section: "reports", labelKey: "ops.nav.reports_marketing", href: "/admin/reports/marketing", permission: "reports.read", flag: "ff_ops_marketing", icon: "megaphone", order: 650 },
  { key: "ops.reports_attribution", area: "admin", section: "reports", labelKey: "ops.nav.reports_attribution", href: "/admin/reports/attribution", permission: "reports.read", flag: "ff_ops_marketing", icon: "activity", order: 660 },
  { key: "ops.reports_ads", area: "admin", section: "reports", labelKey: "ops.nav.reports_ads", href: "/admin/reports/ads", permission: "reports.read", flag: "ff_ops_marketing", icon: "banknote", order: 670 },
  // Data
  { key: "ops.imports", area: "admin", section: "data", labelKey: "ops.nav.imports", href: "/admin/imports", permission: "persons.write", icon: "file-input", order: 800 },
  { key: "ops.exports", area: "admin", section: "data", labelKey: "ops.nav.exports", href: "/admin/reports/exports", permission: "persons.export", icon: "database", order: 810 },
  { key: "ops.privacy", area: "admin", section: "data", labelKey: "ops.nav.privacy", href: "/admin/privacy", permission: "privacy.run", icon: "shield", order: 820 },
  { key: "ops.retention_policies", area: "admin", section: "data", labelKey: "ops.nav.retention_policies", href: "/admin/privacy/retention", permission: "privacy.run", icon: "clock", order: 830 },
  { key: "ops.dpia", area: "admin", section: "data", labelKey: "ops.nav.dpia", href: "/admin/privacy/dpia", permission: "settings.write", icon: "shield-check", order: 840 },
  // Portal
  { key: "ops.account_privacy", area: "portal", section: "account", labelKey: "ops.nav.account_privacy", href: "/account/privacy", icon: "shield", order: 900 },
] as const;
