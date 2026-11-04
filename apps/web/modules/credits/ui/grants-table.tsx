/**
 * The grants table of `/admin/credits` (credits spec section 5): person, package or label, kind,
 * remaining / base, status, source, start, expiry and last use, with the kind, status, source,
 * "expiring in 30 days" and search filters as a GET form (state in the URL) and keyset paging.
 * Server component: strings come from the catalogue through `translator`.
 */
import Link from "next/link";
import { Badge, DataTable, EmptyState, buttonVariants } from "@beam/ui";
import { CREDIT_KINDS, GRANT_SOURCES, GRANT_STATUSES } from "@beam/core/credits";
import { formatDate, formatMoney, type Locale, type LocalizedText } from "@beam/core/i18n";
import { translator } from "@/lib/i18n";
import type { GrantListRow } from "../queries";

type Search = Record<string, string | string[] | undefined>;

export function grantName(row: { productName: LocalizedText | null; label: LocalizedText | null; source: string }, locale: Locale, fallback: string): string {
  return row.productName?.[locale]?.trim() || row.label?.[locale]?.trim() || fallback;
}

/** "4 sessions", "2 nights" or "€ 35,00" in the page locale. */
export function unitsText(kind: string, units: number, locale: Locale): string {
  const tr = translator(locale);
  return kind === "euro" ? formatMoney(units, locale) : tr(`credits.admin.units.${kind}`, { count: units });
}

export const statusVariant = (status: string): "success" | "secondary" | "warning" | "destructive" | "outline" =>
  status === "active" ? "success" : status === "exhausted" ? "secondary" : status === "expired" ? "warning" : status === "revoked" ? "destructive" : "outline";

export function GrantsTable({
  rows,
  nextCursor,
  searchParams,
  locale,
  filtered,
  canCreate,
}: {
  rows: GrantListRow[];
  nextCursor: string | null;
  searchParams: Search;
  locale: Locale;
  filtered: boolean;
  canCreate: boolean;
}) {
  const tr = translator(locale);
  const g = (k: string, p?: Record<string, string | number>) => tr(`credits.admin.grants.${k}`, p);
  const date = (d: Date | null) => (d ? formatDate(d, locale, "medium") : tr("credits.admin.common.none"));
  const amount = (kind: string, n: number) => (kind === "euro" ? formatMoney(n, locale) : String(n));
  return (
    <DataTable<GrantListRow>
      rows={rows}
      nextCursor={nextCursor}
      searchParams={searchParams}
      caption={g("caption")}
      rowKey={(r) => r.grantId}
      filters={[
        { kind: "search", key: "q", label: g("search"), placeholder: g("search") },
        { kind: "select", key: "kind", label: g("filter_kind"), allLabel: tr("credits.admin.common.all"), options: CREDIT_KINDS.map((k) => ({ value: k, label: tr(`credits.enum.kind.${k}`) })) },
        { kind: "select", key: "status", label: g("filter_status"), allLabel: tr("credits.admin.common.all"), options: GRANT_STATUSES.map((s) => ({ value: s, label: tr(`credits.enum.grant_status.${s}`) })) },
        { kind: "select", key: "source", label: g("filter_source"), allLabel: tr("credits.admin.common.all"), options: GRANT_SOURCES.map((s) => ({ value: s, label: tr(`credits.enum.source.${s}`) })) },
        { kind: "select", key: "expiring", label: g("filter_expiring"), allLabel: tr("credits.admin.common.all"), options: [{ value: "30", label: g("expiring") }] },
      ]}
      labels={{
        pagination: tr("credits.admin.common.pagination"),
        previous: tr("credits.admin.common.previous"),
        next: tr("credits.admin.common.next"),
        applyFilters: tr("credits.admin.common.apply"),
        filters: tr("credits.admin.common.filters"),
      }}
      emptyState={
        <EmptyState
          title={filtered ? g("none_match") : g("empty")}
          action={
            canCreate && !filtered ? (
              <Link href="/admin/credits/new" className={buttonVariants()}>
                {g("new")}
              </Link>
            ) : undefined
          }
        />
      }
      columns={[
        {
          key: "person",
          header: g("col_person"),
          cell: (r) => (
            <Link href={`/admin/persons/${r.personId}`} className="hover:underline">
              {r.personName || tr("credits.admin.common.none")}
            </Link>
          ),
        },
        {
          key: "product",
          header: g("col_product"),
          cell: (r) => (
            <Link href={`/admin/credits/grants/${r.grantId}`} className="font-medium hover:underline">
              {grantName(r, locale, g("untitled"))}
            </Link>
          ),
        },
        { key: "kind", header: g("col_kind"), cell: (r) => tr(`credits.enum.kind.${r.kind}`) },
        {
          key: "remaining",
          header: g("col_remaining"),
          align: "right",
          cell: (r) => <span className="tabular-nums">{tr("credits.admin.units.remaining_of", { remaining: amount(r.kind, r.remainingUnits), base: amount(r.kind, r.baseUnits) })}</span>,
        },
        { key: "status", header: g("col_status"), cell: (r) => <Badge variant={statusVariant(r.status)}>{tr(`credits.enum.grant_status.${r.status}`)}</Badge> },
        { key: "source", header: g("col_source"), cell: (r) => tr(`credits.enum.source.${r.source}`) },
        { key: "starts", header: g("col_starts"), cell: (r) => date(r.startsAt) },
        { key: "expires", header: g("col_expires"), cell: (r) => (r.expiresAt ? date(r.expiresAt) : tr("credits.admin.common.no_expiry")) },
        { key: "last_used", header: g("col_last_used"), cell: (r) => date(r.lastUsedAt) },
      ]}
    />
  );
}
