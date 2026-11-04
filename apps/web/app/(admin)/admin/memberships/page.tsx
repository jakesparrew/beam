import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, buttonVariants, DataTable, EmptyState } from "@beam/ui";
import { MEMBERSHIP_STATUSES } from "@beam/core/credits";
import { formatDate } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listMemberships, listPlans, type MembershipListRow, type MembershipStatus } from "@/modules/credits/queries";

type Search = { q?: string; status?: string; plan?: string; renewing?: string; cursor?: string };

/** `/admin/memberships` (`credits.read` or `memberships.write`), credits spec section 5. */
export default async function MembershipsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireStaff();
  if (!hasPermission(actor, "credits.read") && !hasPermission(actor, "memberships.write")) notFound();
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const m = (k: string) => tr(`credits.admin.memberships.${k}`);
  const db = await getAppDb();
  const status = (MEMBERSHIP_STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as MembershipStatus) : undefined;
  const renewing = sp.renewing === "30" ? 30 : undefined;
  const [plans, list] = await Promise.all([
    listPlans(db),
    listMemberships(db, { q: sp.q?.trim() || undefined, status, plan: sp.plan, renewingWithinDays: renewing, cursor: sp.cursor ?? null }),
  ]);
  const filtered = !!(sp.q || status || sp.plan || renewing);
  const date = (d: Date | null) => (d ? formatDate(d, locale, "medium") : tr("credits.admin.common.none"));
  const variant = (s: string) => (s === "active" ? "success" : s === "past_due" ? "destructive" : s === "pending" ? "outline" : "secondary");

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{m("title")}</h1>
        {hasPermission(actor, "memberships.write") ? (
          <Link href="/admin/memberships/plans" className={buttonVariants({ variant: "outline" })}>
            {m("plans")}
          </Link>
        ) : null}
      </header>
      <DataTable<MembershipListRow>
        rows={list.rows}
        nextCursor={list.nextCursor}
        searchParams={sp}
        caption={m("caption")}
        rowKey={(r) => r.membershipId}
        filters={[
          { kind: "search", key: "q", label: m("search"), placeholder: m("search") },
          { kind: "select", key: "status", label: m("filter_status"), allLabel: tr("credits.admin.common.all"), options: MEMBERSHIP_STATUSES.map((s) => ({ value: s, label: tr(`credits.enum.membership_status.${s}`) })) },
          { kind: "select", key: "plan", label: m("filter_plan"), allLabel: tr("credits.admin.common.all"), options: plans.map((p) => ({ value: p.productId, label: p.name[locale] ?? p.sku })) },
          { kind: "select", key: "renewing", label: m("filter_renewal"), allLabel: tr("credits.admin.common.all"), options: [{ value: "30", label: m("renewing") }] },
        ]}
        labels={{
          pagination: tr("credits.admin.common.pagination"),
          previous: tr("credits.admin.common.previous"),
          next: tr("credits.admin.common.next"),
          applyFilters: tr("credits.admin.common.apply"),
          filters: tr("credits.admin.common.filters"),
        }}
        emptyState={<EmptyState title={filtered ? m("none_match") : m("empty")} />}
        columns={[
          {
            key: "person",
            header: m("col_person"),
            cell: (r) => (
              <Link href={`/admin/memberships/${r.membershipId}`} className="font-medium hover:underline">
                {r.personName || tr("credits.admin.common.none")}
              </Link>
            ),
          },
          { key: "plan", header: m("col_plan"), cell: (r) => r.planName[locale] ?? r.planName.en ?? "" },
          { key: "status", header: m("col_status"), cell: (r) => <Badge variant={variant(r.status)}>{tr(`credits.enum.membership_status.${r.status}`)}</Badge> },
          { key: "period_end", header: m("col_period_end"), cell: (r) => date(r.currentPeriodEndAt) },
          { key: "next_charge", header: m("col_next_charge"), cell: (r) => date(r.nextChargeAt) },
          { key: "dunning", header: m("col_dunning"), align: "right", cell: (r) => <span className="tabular-nums">{r.dunningAttempt}</span> },
          { key: "cancel_at", header: m("col_cancel_at"), cell: (r) => date(r.cancelAt) },
        ]}
      />
    </div>
  );
}
