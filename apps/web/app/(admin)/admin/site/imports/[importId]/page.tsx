import NextLink from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { getEditorPickers, siteAdminLabels } from "@/modules/site/queries/admin";
import { getRedirectCoverage, getWordpressImport, listWordpressImportItems, type ImportItemFilter } from "@/modules/site/queries/wordpress";
import { ImportMapping } from "@/modules/site/ui/admin/import-mapping";
import { SiteSectionNav } from "@/modules/site/ui/admin/pages-table";
import { RedirectCoverage } from "@/modules/site/ui/admin/redirect-coverage";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = ["page", "post", "attachment"] as const;
const STATUSES = ["pending", "imported", "skipped", "error"] as const;
const selectClass = "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs";

/** `/admin/site/imports/[importId]` (site spec section 5): mapping, apply, retry, bulk publish and redirect coverage (`site.publish`). */
export default async function SiteImportPage({ params, searchParams }: { params: Promise<{ importId: string }>; searchParams: Promise<{ type?: string; status?: string }> }) {
  await requireStaff({ permission: "site.publish" });
  const { importId } = await params;
  if (!UUID.test(importId)) notFound();
  const sp = await searchParams;
  const locale = await adminLocale();
  const L = siteAdminLabels(locale);
  const db = await getAppDb();
  const detail = await getWordpressImport(importId, db);
  if (!detail) notFound();
  const filter: ImportItemFilter = {
    ...(TYPES.includes(sp.type as (typeof TYPES)[number]) ? { type: sp.type as (typeof TYPES)[number] } : {}),
    ...(STATUSES.includes(sp.status as (typeof STATUSES)[number]) ? { status: sp.status as (typeof STATUSES)[number] } : {}),
  };
  const [items, pickers, coverage] = await Promise.all([
    listWordpressImportItems(importId, filter, db),
    getEditorPickers(locale, db),
    detail.status === "done" || detail.status === "failed" ? getRedirectCoverage(importId, db) : Promise.resolve(null),
  ]);
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <NextLink href="/admin/site/imports" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          {L["import.title"]}
        </NextLink>
        <h1 className="text-2xl font-semibold">{detail.siteOrigin}</h1>
      </div>
      <SiteSectionNav L={L} current={"/admin/site/imports" as never} />
      <form className="flex flex-wrap items-end gap-2" action={`/admin/site/imports/${importId}`}>
        <select name="type" defaultValue={filter.type ?? ""} aria-label={L["import.col.type"]} className={selectClass}>
          <option value="">{L["pages.all"]}</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t === "attachment" ? L["nav.media"] : L[`kind.${t === "post" ? "post" : "standard"}`]}
            </option>
          ))}
        </select>
        <select name="status" defaultValue={filter.status ?? ""} aria-label={L["pages.col.status"]} className={selectClass}>
          <option value="">{L["pages.all"]}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {L[`import.itemStatus.${s}`]}
            </option>
          ))}
        </select>
        <button type="submit" className="h-9 rounded-md border px-3 text-sm">
          {L["pages.search"]}
        </button>
      </form>
      <ImportMapping detail={detail} items={items} L={L} pages={pickers.pages} locale={locale} />
      {coverage ? <RedirectCoverage coverage={coverage} L={L} locale={locale} /> : null}
    </div>
  );
}
