import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listMedia, siteAdminLabels } from "@/modules/site/queries/admin";
import { MediaLibrary } from "@/modules/site/ui/admin/media-library";
import { SiteSectionNav } from "@/modules/site/ui/admin/pages-table";

/** `/admin/site/media` (site spec section 5): media library with upload and alt text per locale (`site.edit`). */
export default async function SiteMediaPage({ searchParams }: { searchParams: Promise<{ q?: string; cursor?: string }> }) {
  await requireStaff({ permission: "site.edit" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const L = siteAdminLabels(locale);
  const { rows } = await listMedia({ q: sp.q?.slice(0, 100), cursor: sp.cursor }, await getAppDb());
  const usageLabels = Object.fromEntries(rows.map((r) => [r.mediaId, tr("site.admin.media.usage", { count: r.usage })]));
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">{L["media.title"]}</h1>
      <SiteSectionNav L={L} current="/admin/site/media" />
      <MediaLibrary rows={rows} L={L} usageLabels={usageLabels} />
    </div>
  );
}
