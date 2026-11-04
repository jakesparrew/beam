import NextLink from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { Badge } from "@beam/ui";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { siteAdminLabels, titleIn } from "@/modules/site/queries/admin";
import { getVersionDiff } from "@/modules/site/queries/proposals";
import { SiteSectionNav } from "@/modules/site/ui/admin/pages-table";
import { VersionReview } from "@/modules/site/ui/admin/version-diff";

/** `site.admin.<key>` with `{name}` placeholders (server side; `lbl` of the pickers is a client module). */
function lbl(L: Record<string, string>, key: string, params: Record<string, string | number> = {}): string {
  return (L[key] ?? key).replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/admin/site/pages/[pageId]/versions/[versionId]` (site spec section 5): the side-by-side diff of
 * a version against its `based_on_version_id` (or the live version), review warnings, rendered
 * previews and, for Claude versions, the instruction and the requester. View with `site.edit`;
 * Publish and Schedule with `site.publish`.
 */
export default async function SiteVersionReview({ params }: { params: Promise<{ pageId: string; versionId: string }> }) {
  const actor = await requireStaff({ permission: "site.edit" });
  const { pageId, versionId } = await params;
  if (!UUID.test(pageId) || !UUID.test(versionId)) notFound();
  const locale = await adminLocale();
  const db = await getAppDb();
  const data = await getVersionDiff(versionId, db);
  if (!data || data.page.pageId !== pageId) notFound();
  const L = siteAdminLabels(locale);
  const v = data.version;
  const title = titleIn(v.title, locale, data.page.slug);
  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold">{lbl(L, "diff.title", { n: v.version })}</h1>
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <NextLink className="underline" href={`/admin/site/pages/${pageId}` as Route}>
            {title}
          </NextLink>
          <Badge variant={v.state === "proposed" ? "warning" : v.state === "published" ? "success" : "outline"}>{lbl(L, `state.${v.state}`)}</Badge>
          {v.createdBy === "claude" ? <span>{lbl(L, "state.createdByClaude", { name: v.createdByName ?? "" })}</span> : null}
          {data.base ? <span>{lbl(L, "diff.base", { n: data.base.version })}</span> : null}
        </p>
      </header>
      <SiteSectionNav L={L} current="/admin/site" />
      <VersionReview data={data} L={L} canPublish={hasPermission(actor, "site.publish")} staffLocale={locale} />
    </div>
  );
}
