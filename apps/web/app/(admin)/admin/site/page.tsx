import NextLink from "next/link";
import { buttonVariants } from "@beam/ui";
import { PAGE_KINDS, type PageKind, type PageStatus } from "@beam/core/site";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getContentIssues, listOpenEditRequests, listPagesForAdmin, siteAdminLabels } from "@/modules/site/queries/admin";
import { ContentIssues } from "@/modules/site/ui/admin/content-issues";
import { PagesTable, SiteSectionNav } from "@/modules/site/ui/admin/pages-table";

/** `/admin/site` (site spec section 5): pages table, content issues with the go-live banner, open Claude requests (`site.edit`). */
export default async function SiteAdminPage({ searchParams }: { searchParams: Promise<{ kind?: string; status?: string; q?: string }> }) {
  await requireStaff({ permission: "site.edit" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const L = siteAdminLabels(locale);
  const kind = (PAGE_KINDS as readonly string[]).includes(sp.kind ?? "") ? (sp.kind as PageKind) : undefined;
  const status = ["draft", "published", "archived"].includes(sp.status ?? "") ? (sp.status as PageStatus) : undefined;
  const q = sp.q?.trim().slice(0, 100) || undefined;
  const db = await getAppDb();
  const [rows, issues, requests] = await Promise.all([
    listPagesForAdmin({ kind, status, q }, locale, db),
    getContentIssues(db, { locale }),
    listOpenEditRequests(locale, db),
  ]);
  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{L["pages.title"]}</h1>
        <NextLink href="/admin/site/pages/new" className={buttonVariants()}>
          {L["pages.new"]}
        </NextLink>
      </header>
      <SiteSectionNav L={L} current="/admin/site" />
      <ContentIssues issues={issues} requests={requests} L={L} />
      <PagesTable rows={rows} L={L} locale={locale} filter={{ kind, status, q }} proposalsLabel={(count) => tr("site.admin.state.openProposals", { count })} />
    </div>
  );
}
