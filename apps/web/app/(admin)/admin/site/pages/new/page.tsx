import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { getEditorPickers, siteAdminLabels } from "@/modules/site/queries/admin";
import { NewPageForm } from "@/modules/site/ui/admin/page-editor";
import { SiteSectionNav } from "@/modules/site/ui/admin/pages-table";

/** `/admin/site/pages/new` (site spec section 5): kind, slug, title per locale, locales, legal key, session (`site.edit`). */
export default async function NewSitePage() {
  await requireStaff({ permission: "site.edit" });
  const locale = await adminLocale();
  const L = siteAdminLabels(locale);
  const pickers = await getEditorPickers(locale, await getAppDb());
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">{L["newPage.title"]}</h1>
      <SiteSectionNav L={L} current="/admin/site" />
      <NewPageForm L={L} sessions={pickers.sessions} />
    </div>
  );
}
