import Link from "next/link";
import type { Route } from "next";
import { Badge, DataTable, EmptyState, buttonVariants, cn } from "@beam/ui";
import { formatDateTime } from "@beam/core/i18n";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { WEBINAR_TABS, countWebinars, listWebinars, type WebinarListRow, type WebinarTab } from "@/modules/webinar/queries";
import { textIn } from "@/modules/webinar/server/lifecycle";

export const dynamic = "force-dynamic";

/**
 * `/admin/webinars` (`webinars.host`, webinar spec 5.1): tabs Upcoming, Live now, Ended,
 * On-demand, Drafts, Cancelled and Archived, with title, mode, start (Brussels), status,
 * registrations, live attendees and replay viewers; a search and "New webinar".
 */
export default async function WebinarsPage({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string; page?: string }> }) {
  await requireStaff({ permission: "webinars.host" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const tab: WebinarTab = (WEBINAR_TABS as readonly string[]).includes(sp.tab ?? "") ? (sp.tab as WebinarTab) : "upcoming";
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const db = await getAppDb();
  const [list, total] = await Promise.all([listWebinars(db, { tab, q: sp.q, page }), countWebinars(db)]);
  const any = total > 0;

  const tabHref = (t: WebinarTab) => `/admin/webinars?tab=${t}` as Route;
  const chip = (active: boolean) => cn("rounded-full border px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent");
  const status = (r: WebinarListRow) => {
    if (r.status === "draft" && r.publishRequestedAt) return <Badge variant="secondary">{tr("webinar.admin.list.publishing")}</Badge>;
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <Badge variant={r.status === "live" ? "default" : r.status === "cancelled" ? "destructive" : "outline"}>{tr(`webinar.enum.status.${r.status}`)}</Badge>
        {r.broadcastError ? <Badge variant="destructive">{tr("webinar.admin.list.broadcast_error")}</Badge> : null}
      </span>
    );
  };

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{tr("webinar.admin.list.title")}</h1>
        <Link href="/admin/webinars/new" className={buttonVariants()}>
          {tr("webinar.admin.list.new")}
        </Link>
      </div>
      {!any ? (
        <EmptyState
          title={tr("webinar.admin.list.empty")}
          description={tr("webinar.admin.list.empty_hint")}
          action={
            <Link href="/admin/webinars/new" className={buttonVariants()}>
              {tr("webinar.admin.list.new")}
            </Link>
          }
        />
      ) : (
        <>
          <nav className="flex flex-wrap gap-2" aria-label={tr("webinar.admin.list.title")}>
            {WEBINAR_TABS.map((t) => (
              <Link key={t} href={tabHref(t)} className={chip(t === tab)} aria-current={t === tab ? "page" : undefined}>
                {tr(`webinar.admin.list.tab.${t}`)}
              </Link>
            ))}
          </nav>
          <DataTable<WebinarListRow>
            rows={list.rows}
            rowKey={(r) => r.id}
            searchParams={{ tab, ...(sp.q ? { q: sp.q } : {}), page: String(page) }}
            cursorParam="page"
            nextCursor={list.hasMore ? String(page + 1) : null}
            prevCursor={page > 1 ? String(page - 1) : null}
            filters={[{ kind: "search", key: "q", label: tr("webinar.admin.list.search"), placeholder: tr("webinar.admin.list.search") }]}
            onRowHref={(r) => `/admin/webinars/${r.id}`}
            labels={{
              pagination: tr("webinar.admin.list.pagination"),
              previous: tr("webinar.admin.list.previous"),
              next: tr("webinar.admin.list.next"),
              applyFilters: tr("webinar.admin.list.apply"),
              filters: tr("webinar.admin.list.filters"),
            }}
            caption={tr(`webinar.admin.list.tab.${tab}`)}
            emptyState={<EmptyState title={tr("webinar.admin.list.tab_empty")} />}
            columns={[
              { key: "title", header: tr("webinar.admin.list.col.title"), cell: (r) => textIn(r.title, locale) || r.slug },
              { key: "mode", header: tr("webinar.admin.list.col.mode"), cell: (r) => tr(`webinar.enum.mode.${r.mode}`) },
              {
                key: "starts",
                header: tr("webinar.admin.list.col.starts"),
                cell: (r) => (r.startsAt ? formatDateTime(r.startsAt, locale) : tr("webinar.admin.list.not_scheduled")),
              },
              { key: "status", header: tr("webinar.admin.list.col.status"), cell: status },
              { key: "registrations", header: tr("webinar.admin.list.col.registrations"), cell: (r) => r.registrations, align: "right" },
              { key: "live", header: tr("webinar.admin.list.col.live_attendees"), cell: (r) => r.liveAttendees, align: "right" },
              { key: "replay", header: tr("webinar.admin.list.col.replay_viewers"), cell: (r) => r.replayViewers, align: "right" },
            ]}
          />
        </>
      )}
    </div>
  );
}
