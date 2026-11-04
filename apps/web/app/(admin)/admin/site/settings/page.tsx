import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { siteAdminLabels } from "@/modules/site/queries/admin";
import { getSiteSettingsSummary } from "@/modules/site/server/settings";
import { SiteSectionNav } from "@/modules/site/ui/admin/pages-table";
import { SettingsSummary } from "@/modules/site/ui/admin/settings-summary";

/** `/admin/site/settings` (site spec section 5): read-only `settings.site` and `settings.company` summary (`site.edit`). */
export default async function SiteSettingsPage() {
  const actor = await requireStaff({ permission: "site.edit" });
  const locale = await adminLocale();
  const L = siteAdminLabels(locale);
  const summary = await getSiteSettingsSummary(await getAppDb());
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">{L["settings.title"]}</h1>
      <SiteSectionNav L={L} current="/admin/site/settings" />
      <SettingsSummary summary={summary} L={L} canEditSettings={hasPermission(actor, "settings.write")} />
    </div>
  );
}
