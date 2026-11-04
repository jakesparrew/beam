import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { siteAdminLabels } from "@/modules/site/queries/admin";
import { listWordpressImports } from "@/modules/site/queries/wordpress";
import { ImportsTable } from "@/modules/site/ui/admin/imports-table";
import { SiteSectionNav } from "@/modules/site/ui/admin/pages-table";

/** `/admin/site/imports` (site spec section 5): WordPress imports with status and counts, and the WXR upload (`site.publish`). */
export default async function SiteImportsPage() {
  await requireStaff({ permission: "site.publish" });
  const locale = await adminLocale();
  const L = siteAdminLabels(locale);
  const rows = await listWordpressImports(await getAppDb());
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">{L["import.title"]}</h1>
      <SiteSectionNav L={L} current={"/admin/site/imports" as never} />
      <ImportsTable rows={rows} L={L} locale={locale} />
    </div>
  );
}
