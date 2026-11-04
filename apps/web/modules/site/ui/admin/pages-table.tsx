/**
 * The pages table of `/admin/site` (site spec section 5): title in the staff locale, kind, status,
 * live version, draft and proposal badges, last published; filter by kind and status, search.
 * A server component: filters are a GET form.
 */
import NextLink from "next/link";
import type { Route } from "next";
import { Badge, Button, buttonVariants, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import type { Locale } from "@beam/core/i18n";
import { PAGE_KINDS, type PageKind, type PageStatus } from "@beam/core/site";
import type { AdminPageRow, SiteAdminLabels } from "../../queries/admin";

const selectClass = "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const SECTIONS = [
  ["/admin/site", "nav.pages"],
  ["/admin/site/navigation", "nav.navigation"],
  ["/admin/site/media", "nav.media"],
  ["/admin/site/redirects", "nav.redirects"],
  ["/admin/site/imports", "nav.imports"],
  ["/admin/site/settings", "nav.settings"],
] as const;

/** The section links of the "Website" area. */
export function SiteSectionNav({ L, current }: { L: SiteAdminLabels; current: (typeof SECTIONS)[number][0] }) {
  return (
    <nav aria-label={L["nav.website"]} className="flex flex-wrap gap-1 border-b pb-2">
      {SECTIONS.map(([href, key]) => (
        <NextLink key={href} href={href} aria-current={href === current ? "page" : undefined} className={buttonVariants({ variant: href === current ? "secondary" : "ghost", size: "sm" })}>
          {L[key]}
        </NextLink>
      ))}
    </nav>
  );
}

const fill = (t: string, p: Record<string, string | number>) => t.replace(/\{(\w+)\}/g, (m, k: string) => (k in p ? String(p[k]) : m));

export function PagesTable({
  rows,
  L,
  locale,
  filter,
  proposalsLabel,
}: {
  rows: AdminPageRow[];
  L: SiteAdminLabels;
  locale: Locale;
  filter: { kind?: PageKind; status?: PageStatus; q?: string };
  proposalsLabel: (count: number) => string;
}) {
  const date = (iso: string | null) => (iso ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "Europe/Brussels" }).format(new Date(iso)) : "—");
  const filtered = !!(filter.kind || filter.status || filter.q);
  return (
    <div className="grid gap-3">
      <form className="flex flex-wrap items-end gap-2" role="search" action="/admin/site">
        <select name="kind" defaultValue={filter.kind ?? ""} aria-label={L["pages.filterKind"]} className={selectClass}>
          <option value="">{L["pages.all"]}</option>
          {PAGE_KINDS.map((k) => (
            <option key={k} value={k}>
              {L[`kind.${k}`]}
            </option>
          ))}
        </select>
        <select name="status" defaultValue={filter.status ?? ""} aria-label={L["pages.filterStatus"]} className={selectClass}>
          <option value="">{L["pages.all"]}</option>
          {(["draft", "published", "archived"] as const).map((s) => (
            <option key={s} value={s}>
              {L[`status.${s}`]}
            </option>
          ))}
        </select>
        <input name="q" defaultValue={filter.q ?? ""} aria-label={L["pages.search"]} placeholder={L["pages.search"]} className={selectClass} />
        <Button type="submit" variant="outline">
          {L["pages.search"]}
        </Button>
      </form>
      {rows.length === 0 ? (
        <EmptyState
          title={L["pages.empty"]}
          action={
            !filtered ? (
              <NextLink href="/admin/site/pages/new" className={buttonVariants()}>
                {L["pages.new"]}
              </NextLink>
            ) : undefined
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{L["pages.col.title"]}</TableHead>
              <TableHead>{L["pages.col.kind"]}</TableHead>
              <TableHead>{L["pages.col.status"]}</TableHead>
              <TableHead>{L["pages.col.live"]}</TableHead>
              <TableHead>{L["pages.col.lastPublished"]}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.pageId}>
                <TableCell>
                  <NextLink className="font-medium underline-offset-4 hover:underline" href={`/admin/site/pages/${r.pageId}` as Route}>
                    {r.title}
                  </NextLink>
                  <div className="text-xs text-muted-foreground">{r.slug}</div>
                </TableCell>
                <TableCell>{L[`kind.${r.kind}`]}</TableCell>
                <TableCell className="flex flex-wrap gap-1">
                  <Badge variant={r.status === "published" ? "success" : r.status === "archived" ? "secondary" : "outline"}>{L[`status.${r.status}`]}</Badge>
                  {r.draftVersionId ? <Badge variant="outline">{L["state.hasDraft"]}</Badge> : null}
                  {r.openProposals ? <Badge variant="warning">{proposalsLabel(r.openProposals)}</Badge> : null}
                  {r.scheduledAt ? <Badge variant="outline">{fill(L["state.scheduled"] ?? "", { date: date(r.scheduledAt) })}</Badge> : null}
                </TableCell>
                <TableCell>{r.liveVersion ? fill(L["state.liveVersion"] ?? "", { n: r.liveVersion }) : "—"}</TableCell>
                <TableCell>{date(r.lastPublishedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
