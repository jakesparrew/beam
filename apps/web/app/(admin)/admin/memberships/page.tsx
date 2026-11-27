import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cn, EmptyState } from "@beam/ui";
import { brusselsDateKey, MEMBERSHIP_STATUSES } from "@beam/core/credits";
import { formatDate } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { creditsLabels, listMemberships, listMonthlyDraws, listPlans, type MembershipStatus } from "@/modules/credits/queries";
import { MonthlyDrawCard } from "@/modules/credits/ui/monthly-draw";
import { PageHeader, SecondaryAction, Segmented, StatusPill, Surface, Toolbar, td, th, type Tone } from "@/modules/platform/ui/admin-kit";
import { Disclosure, Field, fieldClass, Initials, rowClass, rowLink, SearchField } from "@/modules/platform/ui/admin-list-kit";

type Search = { q?: string; status?: string; plan?: string; renewing?: string; cursor?: string };

const STATUS_TONE: Record<MembershipStatus, Tone> = { pending: "muted", active: "ok", past_due: "bad", cancelled: "muted", expired: "muted" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/admin/memberships` (`credits.read` or `memberships.write`), credits spec section 5, in the
 * back-office kit (owner review, November 2026): the Pakketten | Lidmaatschappen switch, the header
 * (plans with `memberships.write`), the monthly draw as one compact line, one toolbar (search
 * first, the status as a segmented switch, plan and "renewing in 30 days" behind "Filters") and
 * the table whose rows open the membership.
 */
export default async function MembershipsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireStaff();
  if (!hasPermission(actor, "credits.read") && !hasPermission(actor, "memberships.write")) notFound();
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const m = (k: string) => tr(`credits.admin.memberships.${k}`);
  const db = await getAppDb();
  const status = (MEMBERSHIP_STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as MembershipStatus) : undefined;
  const renewing = sp.renewing === "30" ? "30" : undefined;
  const plan = sp.plan && UUID.test(sp.plan) ? sp.plan : undefined;
  const q = sp.q?.trim().slice(0, 100) || undefined;
  const [plans, list, draws] = await Promise.all([
    listPlans(db),
    listMemberships(db, { q, status, plan, renewingWithinDays: renewing ? 30 : undefined, cursor: sp.cursor ?? null }),
    listMonthlyDraws(db),
  ]);
  const canWrite = hasPermission(actor, "memberships.write");
  const canCredits = hasPermission(actor, "credits.read");
  const filtered = !!(q || status || plan || renewing);
  const date = (d: Date | null) => (d ? formatDate(d, locale, "medium") : null);
  const dash = <span className="text-muted-foreground">–</span>;

  const current: Record<string, string | undefined> = { q, status, plan, renewing };
  const href = (patch: Record<string, string | undefined>): Route => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...current, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/admin/memberships?${s}` : "/admin/memberships";
  };
  const moreFilters = [plan, renewing].filter(Boolean).length;

  return (
    <div className="grid gap-4">
      {canCredits ? (
        <Segmented
          label={tr("credits.admin.area.label")}
          items={[
            { key: "credits", label: tr("credits.admin.grants.title"), href: "/admin/credits", active: false },
            { key: "memberships", label: m("title"), href: "/admin/memberships", active: true },
          ]}
        />
      ) : null}
      <PageHeader title={m("title")} description={m("subtitle")} actions={canWrite ? <SecondaryAction href="/admin/memberships/plans">{m("plans")}</SecondaryAction> : null} />

      <MonthlyDrawCard
        month={brusselsDateKey(new Date()).slice(0, 7)}
        draws={draws.map(({ month, personId, personName }) => ({ month, personId, personName }))}
        canDraw={canWrite}
        labels={creditsLabels(locale, ["admin.draw", "errors"])}
      />

      <form data-auto-filter="" method="get" role="search">
        <Toolbar>
          <SearchField label={m("search")} placeholder={m("search")} defaultValue={q} />
          {status ? <input type="hidden" name="status" value={status} /> : null}
          <Segmented
            label={m("filter_status")}
            items={[
              { key: "all", label: tr("credits.admin.common.all"), href: href({ status: undefined, cursor: undefined }), active: !status },
              ...MEMBERSHIP_STATUSES.map((s) => ({ key: s, label: tr(`credits.enum.membership_status.${s}`), href: href({ status: s, cursor: undefined }), active: status === s })),
            ]}
          />
          <Disclosure label={tr("credits.admin.common.filters")} count={moreFilters} clear={moreFilters ? { href: href({ plan: undefined, renewing: undefined, cursor: undefined }), label: tr("credits.admin.common.clear") } : null}>
            <Field label={m("filter_plan")}>
              <select name="plan" defaultValue={plan ?? ""} className={fieldClass}>
                <option value="">{tr("credits.admin.common.all")}</option>
                {plans.map((p) => (
                  <option key={p.productId} value={p.productId}>
                    {p.name[locale] ?? p.sku}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={m("filter_renewal")}>
              <select name="renewing" defaultValue={renewing ?? ""} className={fieldClass}>
                <option value="">{tr("credits.admin.common.all")}</option>
                <option value="30">{m("renewing")}</option>
              </select>
            </Field>
          </Disclosure>
        </Toolbar>
      </form>

      {list.rows.length === 0 ? (
        <EmptyState title={filtered ? m("none_match") : m("empty")} />
      ) : (
        <Surface flush data-testid="memberships-list">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-[0.8125rem]">
              <caption className="sr-only">{m("caption")}</caption>
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={th}>{m("col_person")}</th>
                  <th scope="col" className={cn(th, "w-48")}>{m("col_plan")}</th>
                  <th scope="col" className={cn(th, "w-32")}>{m("col_status")}</th>
                  <th scope="col" className={cn(th, "w-36")}>{m("col_period_end")}</th>
                  <th scope="col" className={cn(th, "w-36")}>{m("col_next_charge")}</th>
                  <th scope="col" className={cn(th, "w-28 text-right")}>{m("col_dunning")}</th>
                  <th scope="col" className={cn(th, "w-32")}>{m("col_cancel_at")}</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((r) => (
                  <tr key={r.membershipId} className={rowClass} data-testid="memberships-row">
                    <td className={td}>
                      <span className="flex items-center gap-2.5">
                        <Initials name={r.personName} />
                        <Link href={`/admin/memberships/${r.membershipId}`} className={cn(rowLink, "font-medium hover:underline")}>
                          {r.personName || tr("credits.admin.common.none")}
                        </Link>
                      </span>
                    </td>
                    <td className={td}>{r.planName[locale] ?? r.planName.en ?? ""}</td>
                    <td className={td}>
                      <StatusPill tone={STATUS_TONE[r.status]}>{tr(`credits.enum.membership_status.${r.status}`)}</StatusPill>
                    </td>
                    <td className={cn(td, "whitespace-nowrap")}>{date(r.currentPeriodEndAt) ?? dash}</td>
                    <td className={cn(td, "whitespace-nowrap")}>{date(r.nextChargeAt) ?? dash}</td>
                    <td className={cn(td, "text-right tabular-nums", r.dunningAttempt > 0 && "font-semibold text-[var(--status-bad)]")}>{r.dunningAttempt}</td>
                    <td className={cn(td, "whitespace-nowrap")}>{date(r.cancelAt) ?? dash}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Surface>
      )}
      {sp.cursor || list.nextCursor ? (
        <nav className="flex gap-2" aria-label={m("caption")}>
          {sp.cursor ? <SecondaryAction href={href({ cursor: undefined })}>{tr("credits.admin.common.first_page")}</SecondaryAction> : null}
          {list.nextCursor ? <SecondaryAction href={href({ cursor: list.nextCursor })}>{tr("credits.admin.common.next")}</SecondaryAction> : null}
        </nav>
      ) : null}
    </div>
  );
}
