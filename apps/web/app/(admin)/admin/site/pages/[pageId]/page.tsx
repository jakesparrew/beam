import { notFound } from "next/navigation";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { getEditorPickers, getPageEditor, siteAdminLabels, titleIn } from "@/modules/site/queries/admin";
import { PageEditor } from "@/modules/site/ui/admin/page-editor";
import { SiteSectionNav } from "@/modules/site/ui/admin/pages-table";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/admin/site/pages/[pageId]` (site spec section 5): the page editor (`site.edit`; publish controls with `site.publish`). */
export default async function SitePageEditor({ params }: { params: Promise<{ pageId: string }> }) {
  const actor = await requireStaff({ permission: "site.edit" });
  const { pageId } = await params;
  if (!UUID.test(pageId)) notFound();
  const locale = await adminLocale();
  const db = await getAppDb();
  const data = await getPageEditor(pageId, db);
  if (!data) notFound();
  const L = siteAdminLabels(locale);
  const pickers = await getEditorPickers(locale, db);
  const title = titleIn(data.base?.title, locale, data.page.slug);
  const rich = { bold: "B", italic: "I", h2: "H2", h3: "H3", bullets: "•", numbers: "1.", quote: "❝", link: L["block.link.url"] ?? "Link", linkPrompt: L["block.link.url"] ?? "URL" };
  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">
          {L[`kind.${data.page.kind}`]} · {data.page.slug}
        </p>
      </header>
      <SiteSectionNav L={L} current="/admin/site" />
      <PageEditor key={`${data.page.updatedAt}:${data.draft?.updatedAt ?? ""}:${data.page.status}`} data={data} pickers={pickers} L={L} rich={rich} canPublish={hasPermission(actor, "site.publish")} staffLocale={locale} />
    </div>
  );
}
