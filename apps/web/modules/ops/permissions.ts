/**
 * ops permissions (ops spec 7, architecture section 4, 02-data-model 5.3). Facade read by
 * `pnpm gen:indexes`. `reports.read` (dashboards, reports, retention list, pipeline board),
 * `reports.finance` (financial report details), `dashboards.manage` (custom dashboards, R4) and
 * `privacy.run` (verify, run and cancel privacy requests; retention policies). The other
 * permissions ops checks (`persons.*`, `tasks.all`, `crm.b2b`, `credits.read`, `invoices.read`,
 * `settings.write`, `users.manage`, `ai.use`) are declared by their owners. Descriptions are
 * `ops.permissions.<permission with _>` in the catalogue.
 */
export const permissions = ["reports.read", "reports.finance", "dashboards.manage", "privacy.run"] as const;
