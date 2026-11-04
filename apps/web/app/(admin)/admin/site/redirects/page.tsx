import { Button } from "@beam/ui";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { getEditorPickers, listRedirects, siteAdminLabels, type AdminRedirectRow } from "@/modules/site/queries/admin";
import { SiteSectionNav } from "@/modules/site/ui/admin/pages-table";
import { RedirectsTable } from "@/modules/site/ui/admin/redirects-table";

const SOURCES: AdminRedirectRow["source"][] = ["manual", "rename", "archive", "wordpress"];
const selectClass = "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs";

/** `/admin/site/redirects` (site spec section 5): redirects with approximate hits (view `site.edit`, change `site.publish`). */
export default async function SiteRedirectsPage({ searchParams }: { searchParams: Promise<{ q?: string; source?: string; cursor?: string }> }) {
  const actor = await requireStaff({ permission: "site.edit" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const L = siteAdminLabels(locale);
  const db = await getAppDb();
  const source = SOURCES.includes(sp.source as AdminRedirectRow["source"]) ? (sp.source as AdminRedirectRow["source"]) : undefined;
  const [{ rows }, pickers] = await Promise.all([listRedirects({ q: sp.q?.slice(0, 200), source, cursor: sp.cursor }, locale, db), getEditorPickers(locale, db)]);
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">{L["redirects.title"]}</h1>
      <SiteSectionNav L={L} current="/admin/site/redirects" />
      <form className="flex flex-wrap items-end gap-2" role="search" action="/admin/site/redirects">
        <select name="source" defaultValue={source ?? ""} aria-label={L["redirects.source"]} className={selectClass}>
          <option value="">{L["pages.all"]}</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {L[`redirects.sourceKind.${s}`]}
            </option>
          ))}
        </select>
        <input name="q" defaultValue={sp.q ?? ""} aria-label={L["pages.search"]} placeholder={L["redirects.from"]} className={selectClass} />
        <Button type="submit" variant="outline">
          {L["pages.search"]}
        </Button>
      </form>
      <RedirectsTable rows={rows} L={L} pickers={pickers} canEdit={hasPermission(actor, "site.publish")} locale={locale} />
    </div>
  );
}
