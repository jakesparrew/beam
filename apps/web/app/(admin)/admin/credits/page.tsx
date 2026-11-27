import type { Route } from "next";
import Link from "next/link";
import { cn, EmptyState } from "@beam/ui";
import { CREDIT_KINDS, GRANT_SOURCES, GRANT_STATUSES, type CreditKind } from "@beam/core/credits";
import { formatDate, formatMoney, formatNumber } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getCreditsTiles, listGrants, type GrantSource, type GrantStatus } from "@/modules/credits/queries";
import { grantName } from "@/modules/credits/ui/grants-table";
import { PageHeader, PrimaryAction, SecondaryAction, Segmented, StatusPill, Surface, Toolbar, td, th, type Tone } from "@/modules/platform/ui/admin-kit";
import { aboveRow, Disclosure, Field, fieldClass, Initials, KpiStrip, rowClass, rowLink, SearchField } from "@/modules/platform/ui/admin-list-kit";

type Search = { q?: string; kind?: string; status?: string; source?: string; expiring?: string; person?: string; cursor?: string };

const pick = <T extends string>(list: readonly T[], v: string | undefined): T | undefined => ((list as readonly string[]).includes(v ?? "") ? (v as T) : undefined);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_TONE: Record<GrantStatus, Tone> = { active: "ok", exhausted: "muted", expired: "warn", revoked: "bad" };
const SOON = 30 * 86_400_000;

/**
 * `/admin/credits` (`credits.read`, credits spec section 5), in the back-office kit (owner review,
 * November 2026): the Pakketten | Lidmaatschappen switch that ties both pages into one area, the
 * header (new grant with `credits.adjust`; reconciliation and bulk extension quiet), the credits
 * figures, one toolbar (search first, status and kind as segmented switches, source and "expiring
 * in 30 days" behind "Filters") and the grants table whose rows open the grant.
 */
export default async function CreditsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireStaff({ permission: "credits.read" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const g = (k: string, p?: Record<string, string | number>) => tr(`credits.admin.grants.${k}`, p);
  const db = await getAppDb();
  const kind = pick<CreditKind>(CREDIT_KINDS, sp.kind);
  const status = pick<GrantStatus>(GRANT_STATUSES, sp.status);
  const source = pick<GrantSource>(GRANT_SOURCES, sp.source);
  const expiring = sp.expiring === "30" ? "30" : undefined;
  const person = sp.person && UUID.test(sp.person) ? sp.person : undefined;
  const q = sp.q?.trim().slice(0, 100) || undefined;
  const [tiles, list] = await Promise.all([
    getCreditsTiles(db),
    listGrants(db, { q, kind, status, source, expiringWithinDays: expiring ? 30 : undefined, personId: person, cursor: sp.cursor ?? null }),
  ]);
  const canAdjust = hasPermission(actor, "credits.adjust");
  const filtered = !!(q || kind || status || source || expiring || person);
  const n = (v: number) => formatNumber(v, locale);
  const date = (d: Date | null) => (d ? formatDate(d, locale, "medium") : null);
  const amount = (k: string, v: number) => (k === "euro" ? formatMoney(v, locale) : String(v));
  const now = new Date().getTime();

  const current: Record<string, string | undefined> = { q, kind, status, source, expiring, person };
  const href = (patch: Record<string, string | undefined>): Route => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...current, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/admin/credits?${s}` : "/admin/credits";
  };
  const moreFilters = [source, expiring, person].filter(Boolean).length;
  const t = (k: string) => tr(`credits.admin.tiles.${k}`);
  const outstanding = tiles.outstanding.filter((o) => o.kind !== "euro");

  return (
    <div className="grid gap-4">
      <Segmented
        label={tr("credits.admin.area.label")}
        items={[
          { key: "credits", label: g("title"), href: "/admin/credits", active: true },
          { key: "memberships", label: tr("credits.admin.memberships.title"), href: "/admin/memberships", active: false },
        ]}
      />
      <PageHeader
        title={g("title")}
        description={g("subtitle")}
        actions={
          <>
            <SecondaryAction href="/admin/credits/reconciliation">{g("reconciliation")}</SecondaryAction>
            {canAdjust ? <SecondaryAction href="/admin/credits/bulk-extend">{g("bulk")}</SecondaryAction> : null}
            {canAdjust ? <PrimaryAction href="/admin/credits/new">+ {g("new")}</PrimaryAction> : null}
          </>
        }
      />

      <KpiStrip
        aria-label={t("label")}
        items={[
          { key: "active", label: t("active_grants"), value: n(tiles.activeGrants), href: href({ status: "active", cursor: undefined }) },
          { key: "outstanding", label: t("outstanding"), value: outstanding.map((o) => `${n(o.units)} ${tr(`credits.enum.kind.${o.kind}`).toLowerCase()}`).join(" · ") || "0" },
          { key: "expiring", label: t("expiring"), value: n(tiles.expiringIn30Days), href: href({ expiring: "30", cursor: undefined }), ...(tiles.expiringIn30Days ? { tone: "warn" as const } : {}) },
          { key: "value", label: t("value"), value: formatMoney(tiles.outstandingValueCents, locale), sub: `${tr("credits.enum.kind.euro")}: ${formatMoney(tiles.outstanding.find((o) => o.kind === "euro")?.units ?? 0, locale)}` },
        ]}
      />

      <form data-auto-filter="" method="get" role="search">
        <Toolbar>
          <SearchField label={g("search")} placeholder={g("search")} defaultValue={q} />
          {status ? <input type="hidden" name="status" value={status} /> : null}
          {kind ? <input type="hidden" name="kind" value={kind} /> : null}
          {person ? <input type="hidden" name="person" value={person} /> : null}
          <Segmented
            label={g("filter_status")}
            items={[
              { key: "all", label: tr("credits.admin.common.all"), href: href({ status: undefined, cursor: undefined }), active: !status },
              ...GRANT_STATUSES.map((s) => ({ key: s, label: tr(`credits.enum.grant_status.${s}`), href: href({ status: s, cursor: undefined }), active: status === s })),
            ]}
          />
          <Segmented
            label={g("filter_kind")}
            items={[
              { key: "all", label: tr("credits.admin.common.all"), href: href({ kind: undefined, cursor: undefined }), active: !kind },
              ...CREDIT_KINDS.map((k) => ({ key: k, label: tr(`credits.enum.kind.${k}`), href: href({ kind: k, cursor: undefined }), active: kind === k })),
            ]}
          />
          <Disclosure label={tr("credits.admin.common.filters")} count={moreFilters} clear={moreFilters ? { href: href({ source: undefined, expiring: undefined, person: undefined, cursor: undefined }), label: tr("credits.admin.common.clear") } : null}>
            <Field label={g("filter_source")}>
              <select name="source" defaultValue={source ?? ""} className={fieldClass}>
                <option value="">{tr("credits.admin.common.all")}</option>
                {GRANT_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {tr(`credits.enum.source.${s}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={g("filter_expiring")}>
              <select name="expiring" defaultValue={expiring ?? ""} className={fieldClass}>
                <option value="">{tr("credits.admin.common.all")}</option>
                <option value="30">{g("expiring")}</option>
              </select>
            </Field>
          </Disclosure>
        </Toolbar>
      </form>

      {list.rows.length === 0 ? (
        <EmptyState title={filtered ? g("none_match") : g("empty")} action={canAdjust && !filtered ? <Link href="/admin/credits/new">{g("new")}</Link> : undefined} />
      ) : (
        <Surface flush data-testid="grants-list">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-[0.8125rem]">
              <caption className="sr-only">{g("caption")}</caption>
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={th}>{g("col_product")}</th>
                  <th scope="col" className={cn(th, "w-56")}>{g("col_person")}</th>
                  <th scope="col" className={cn(th, "w-32 text-right")}>{g("col_remaining")}</th>
                  <th scope="col" className={cn(th, "w-28")}>{g("col_status")}</th>
                  <th scope="col" className={cn(th, "w-36")}>{g("col_expires")}</th>
                  <th scope="col" className={cn(th, "w-32")}>{g("col_last_used")}</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((r) => {
                  const soon = r.status === "active" && r.expiresAt && r.expiresAt.getTime() - now < SOON;
                  return (
                    <tr key={r.grantId} className={rowClass} data-testid="grants-row">
                      <td className={td}>
                        <span className="grid leading-tight">
                          <Link href={`/admin/credits/grants/${r.grantId}`} className={cn(rowLink, "font-medium hover:underline")}>
                            {grantName(r, locale, g("untitled"))}
                          </Link>
                          <span className="text-[0.75rem] text-muted-foreground">
                            {tr(`credits.enum.kind.${r.kind}`)} · {tr(`credits.enum.source.${r.source}`)} · {g("started", { date: date(r.startsAt) ?? "" })}
                          </span>
                        </span>
                      </td>
                      <td className={td}>
                        <span className="flex items-center gap-2">
                          <Initials name={r.personName} />
                          <Link href={`/admin/persons/${r.personId}`} className={cn(aboveRow, "truncate hover:underline")}>
                            {r.personName || tr("credits.admin.common.none")}
                          </Link>
                        </span>
                      </td>
                      <td className={cn(td, "text-right whitespace-nowrap tabular-nums")}>
                        <span className="font-semibold">{amount(r.kind, r.remainingUnits)}</span>
                        <span className="text-muted-foreground">/{amount(r.kind, r.baseUnits)}</span>
                      </td>
                      <td className={td}>
                        <StatusPill tone={STATUS_TONE[r.status]}>{tr(`credits.enum.grant_status.${r.status}`)}</StatusPill>
                      </td>
                      <td className={cn(td, "whitespace-nowrap")}>
                        {r.expiresAt ? <span className={soon ? "font-semibold text-[var(--status-warn)]" : undefined}>{date(r.expiresAt)}</span> : <span className="text-muted-foreground">{tr("credits.admin.common.no_expiry")}</span>}
                      </td>
                      <td className={cn(td, "whitespace-nowrap")}>{date(r.lastUsedAt) ?? <span className="text-muted-foreground">–</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Surface>
      )}
      {sp.cursor || list.nextCursor ? (
        <nav className="flex gap-2" aria-label={g("caption")}>
          {sp.cursor ? <SecondaryAction href={href({ cursor: undefined })}>{tr("credits.admin.common.first_page")}</SecondaryAction> : null}
          {list.nextCursor ? <SecondaryAction href={href({ cursor: list.nextCursor })}>{tr("credits.admin.common.next")}</SecondaryAction> : null}
        </nav>
      ) : null}
    </div>
  );
}
