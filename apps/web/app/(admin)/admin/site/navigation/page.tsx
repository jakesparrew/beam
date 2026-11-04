import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { getEditorPickers, listNavMenusForAdmin, siteAdminLabels } from "@/modules/site/queries/admin";
import { NavEditor } from "@/modules/site/ui/admin/nav-editor";
import { SiteSectionNav } from "@/modules/site/ui/admin/pages-table";

/** `/admin/site/navigation` (site spec section 5): header, footer and legal menus (view `site.edit`, save `site.publish`). */
export default async function SiteNavigationPage() {
  const actor = await requireStaff({ permission: "site.edit" });
  const locale = await adminLocale();
  const db = await getAppDb();
  const L = siteAdminLabels(locale);
  const [menus, pickers] = await Promise.all([listNavMenusForAdmin(db), getEditorPickers(locale, db)]);
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">{L["navigation.title"]}</h1>
      <SiteSectionNav L={L} current="/admin/site/navigation" />
      <NavEditor menus={menus} L={L} pickers={pickers} canEdit={hasPermission(actor, "site.publish")} />
    </div>
  );
}
