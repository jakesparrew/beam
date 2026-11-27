import type { Route } from "next";
import Link from "next/link";
import { cn, EmptyState } from "@beam/ui";
import { PAGE_KINDS, type PageKind, type PageStatus } from "@beam/core/site";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getContentIssues, listOpenEditRequests, listPagesForAdmin, siteAdminLabels } from "@/modules/site/queries/admin";
import { ContentIssues } from "@/modules/site/ui/admin/content-issues";
import { SiteSectionNav } from "@/modules/site/ui/admin/pages-table";
import { PageHeader, PrimaryAction, Segmented, StatusPill, Surface, Toolbar, td, th, type Tone } from "@/modules/platform/ui/admin-kit";
import { Disclosure, Field, fieldClass, rowClass, rowLink, SearchField } from "@/modules/platform/ui/admin-list-kit";

const STATUSES = ["draft", "published", "archived"] as const;
const TONE: Record<PageStatus, Tone> = { draft: "muted", published: "ok", archived: "muted" };
const fill = (t: string, p: Record<string, string | number>) => t.replace(/\{(\w+)\}/g, (m, k: string) => (k in p ? String(p[k]) : m));

/**
 * `/admin/site` (site spec section 5; `site.edit`), in the back-office kit (owner review, November
 * 2026): the Website area's tabs, the content issues with the go-live banner and the open Claude
 * requests, then the pages: a search, status tabs and the kind behind "Filters", and a table
 * (title with slug, kind, status with draft, proposal and schedule pills, live version, last
 * published) whose rows open the page.
 */
export default async function SiteAdminPage({ searchParams }: { searchParams: Promise<{ kind?: string; status?: string; q?: string }> }) {
  await requireStaff({ permission: "site.edit" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const L = siteAdminLabels(locale);
  const kind = (PAGE_KINDS as readonly string[]).includes(sp.kind ?? "") ? (sp.kind as PageKind) : undefined;
  const status = (STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as PageStatus) : undefined;
  const q = sp.q?.trim().slice(0, 100) || undefined;
  const db = await getAppDb();
  const [rows, issues, requests] = await Promise.all([listPagesForAdmin({ kind, status, q }, locale, db), getContentIssues(db, { locale }), listOpenEditRequests(locale, db)]);
  const date = (iso: string | null) => (iso ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "Europe/Brussels" }).format(new Date(iso)) : "–");
  const href = (patch: Record<string, string | undefined>): Route => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ q, status, kind, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/admin/site?${s}` : "/admin/site";
  };

  return (
    <div className="grid gap-4">
      <PageHeader title={L["nav.website"]} description={tr("site.admin.pages.subtitle")} actions={<PrimaryAction href="/admin/site/pages/new">+ {L["pages.new"]}</PrimaryAction>} />
      <SiteSectionNav L={L} current="/admin/site" />
      <ContentIssues issues={issues} requests={requests} L={L} />
      <form data-auto-filter="" method="get" role="search" action="/admin/site">
        <Toolbar>
          {status ? <input type="hidden" name="status" value={status} /> : null}
          <SearchField label={L["pages.search"] ?? ""} placeholder={L["pages.search"] ?? ""} defaultValue={q} />
          <Segmented
            label={L["pages.filterStatus"] ?? ""}
            items={[{ key: "all", label: L["pages.all"], href: href({ status: undefined }), active: !status }, ...STATUSES.map((s) => ({ key: s, label: L[`status.${s}`], href: href({ status: s }), active: status === s }))]}
          />
          <Disclosure label={tr("site.admin.pages.filters")} count={kind ? 1 : 0} clear={kind ? { href: href({ kind: undefined }), label: tr("site.admin.pages.clear") } : null}>
            <Field label={L["pages.filterKind"] ?? ""}>
              <select name="kind" defaultValue={kind ?? ""} className={fieldClass}>
                <option value="">{L["pages.all"]}</option>
                {PAGE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {L[`kind.${k}`]}
                  </option>
                ))}
              </select>
            </Field>
          </Disclosure>
        </Toolbar>
      </form>
      {rows.length === 0 ? (
        <EmptyState title={L["pages.empty"]} />
      ) : (
        <Surface flush>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-[0.8125rem]">
              <caption className="sr-only">{L["pages.title"]}</caption>
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={th}>{L["pages.col.title"]}</th>
                  <th scope="col" className={cn(th, "w-36")}>{L["pages.col.kind"]}</th>
                  <th scope="col" className={cn(th, "w-64")}>{L["pages.col.status"]}</th>
                  <th scope="col" className={cn(th, "w-32")}>{L["pages.col.live"]}</th>
                  <th scope="col" className={cn(th, "w-40")}>{L["pages.col.lastPublished"]}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.pageId} className={rowClass} data-page-id={r.pageId}>
                    <td className={td}>
                      <span className="grid leading-tight">
                        <Link className={cn(rowLink, "font-semibold hover:underline")} href={`/admin/site/pages/${r.pageId}` as Route}>
                          {r.title}
                        </Link>
                        <span className="text-[0.75rem] text-muted-foreground">{r.slug}</span>
                      </span>
                    </td>
                    <td className={cn(td, "text-muted-foreground")}>{L[`kind.${r.kind}`]}</td>
                    <td className={td}>
                      <span className="flex flex-wrap gap-1">
                        <StatusPill tone={TONE[r.status]}>{L[`status.${r.status}`]}</StatusPill>
                        {r.draftVersionId ? <StatusPill tone="muted">{L["state.hasDraft"]}</StatusPill> : null}
                        {r.openProposals ? <StatusPill tone="gold">{tr("site.admin.state.openProposals", { count: r.openProposals })}</StatusPill> : null}
                        {r.scheduledAt ? <StatusPill tone="info">{fill(L["state.scheduled"] ?? "", { date: date(r.scheduledAt) })}</StatusPill> : null}
                      </span>
                    </td>
                    <td className={cn(td, "tabular-nums")}>{r.liveVersion ? fill(L["state.liveVersion"] ?? "", { n: r.liveVersion }) : "–"}</td>
                    <td className={cn(td, "whitespace-nowrap text-muted-foreground")}>{date(r.lastPublishedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Surface>
      )}
    </div>
  );
}
