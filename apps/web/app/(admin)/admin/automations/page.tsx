import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cn, EmptyState } from "@beam/ui";
import { formatDateTime } from "@beam/core/i18n";
import { AUTOMATION_CATEGORIES, type AutomationCategory } from "@beam/core/automation";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { automationLabels, canViewAutomations, listAutomations, listGroupOptions, type AutomationStatus } from "@/modules/automation/queries";
import { fill } from "@/modules/automation/ui/outcome-badge";
import { PageHeader, PrimaryAction, Segmented, StatusPill, Surface, Toolbar, td, th, type Tone } from "@/modules/platform/ui/admin-kit";
import { Disclosure, Field, fieldClass, rowClass, rowLink, SearchField } from "@/modules/platform/ui/admin-list-kit";

const STATUSES = ["draft", "active", "paused", "archived"] as const;
const STATUS_TONE: Record<AutomationStatus, Tone> = { draft: "muted", active: "ok", paused: "warn", archived: "muted" };

/**
 * `/admin/automations` (automation spec 5; `automations.write` or `reports.read`, New needs
 * `automations.write`), in the back-office kit (owner review, November 2026): every automation
 * with group, status, version and the last 7 days from `v_automation_stats`. A search, the
 * category tabs (derived from the trigger; "All" groups the table by category) and status and
 * group behind "Filters". The groups, and with `automations.publish` the frequency rules and the
 * conflict report, sit behind "More".
 */
export default async function AutomationsPage({ searchParams }: { searchParams: Promise<{ status?: string; group?: string; q?: string; category?: string }> }) {
  const actor = await requireStaff();
  if (!canViewAutomations(actor)) notFound();
  const sp = await searchParams;
  const locale = await adminLocale();
  const l = automationLabels(locale, ["list", "status", "common"]);
  const db = await getAppDb();
  const status = (STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as AutomationStatus) : undefined;
  const category = (AUTOMATION_CATEGORIES as readonly string[]).includes(sp.category ?? "") ? (sp.category as AutomationCategory) : undefined;
  const group = sp.group || undefined;
  const q = sp.q?.trim().slice(0, 100) || undefined;
  const [all, groups] = await Promise.all([listAutomations(db, { status, groupKey: group, q }), listGroupOptions(db)]);
  const counts = Object.fromEntries(AUTOMATION_CATEGORIES.map((c) => [c, all.filter((r) => r.category === c).length])) as Record<AutomationCategory, number>;
  const rows = category ? all.filter((r) => r.category === category) : AUTOMATION_CATEGORIES.flatMap((c) => all.filter((r) => r.category === c));
  const canWrite = hasPermission(actor, "automations.write");
  // The rules (A-32) and conflict report (A-37) screens need `automations.publish`.
  const canPublish = hasPermission(actor, "automations.publish");
  const href = (patch: Record<string, string | undefined>): Route => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ q, status, group, category, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/admin/automations?${s}` : "/admin/automations";
  };
  const more: { key: string; href: Route; label: string }[] = [
    { key: "groups", href: "/admin/automations/groups", label: l["list.groups"] ?? "" },
    ...(canPublish
      ? [
          { key: "rules", href: "/admin/automations/rules" as Route, label: l["list.rules"] ?? "" },
          { key: "conflicts", href: "/admin/automations/conflicts" as Route, label: l["list.conflicts"] ?? "" },
        ]
      : []),
  ];
  const moreFilters = [status, group].filter(Boolean).length;
  const filtered = !!(status || group || q || category);
  const COLS = 9;

  return (
    <div className="grid gap-4">
      <PageHeader
        title={l["list.title"]}
        description={l["list.description"]}
        actions={
          <>
            <Disclosure label={l["list.more"] ?? ""} align="right">
              <ul className="grid gap-0.5 text-[0.8125rem]">
                {more.map((m) => (
                  <li key={m.key}>
                    <Link href={m.href} className="block rounded-md px-2 py-1.5 font-medium hover:bg-muted">
                      {m.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </Disclosure>
            {canWrite ? <PrimaryAction href="/admin/automations/new">+ {l["list.new"]}</PrimaryAction> : null}
          </>
        }
      />

      <form data-auto-filter="" method="get" action="/admin/automations" role="search" data-testid="automation-filters">
        <Toolbar>
          {category ? <input type="hidden" name="category" value={category} /> : null}
          <SearchField label={l["list.search"] ?? ""} placeholder={l["list.search_placeholder"] ?? ""} defaultValue={q} />
          <div data-testid="automation-categories">
            <Segmented
              label={l["list.categories"] ?? ""}
              items={[
                { key: "all", label: l["list.category_all"], href: href({ category: undefined }), active: !category, count: all.length },
                ...AUTOMATION_CATEGORIES.filter((c) => counts[c] > 0 || c === category).map((c) => ({ key: c, label: l[`list.category.${c}`] ?? c, href: href({ category: c }), active: c === category, count: counts[c] })),
              ]}
            />
          </div>
          <Disclosure label={l["list.filters"] ?? ""} count={moreFilters} clear={moreFilters ? { href: href({ status: undefined, group: undefined }), label: l["list.clear"] ?? "" } : null}>
            <Field label={l["list.filter_status"] ?? ""}>
              <select id="automation-filter-status" name="status" defaultValue={status ?? ""} className={fieldClass}>
                <option value="">{l["common.all"]}</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {l[`status.${s}`]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={l["list.filter_group"] ?? ""}>
              <select id="automation-filter-group" name="group" defaultValue={group ?? ""} className={fieldClass}>
                <option value="">{l["common.all"]}</option>
                {groups.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.name}
                  </option>
                ))}
              </select>
            </Field>
          </Disclosure>
        </Toolbar>
      </form>

      {rows.length === 0 ? (
        <EmptyState title={filtered ? l["list.empty_filtered"] : l["list.empty"]} action={!filtered && canWrite ? <PrimaryAction href="/admin/automations/new">+ {l["list.new"]}</PrimaryAction> : undefined} />
      ) : (
        <Surface flush>
          <div className="overflow-x-auto">
            <table data-testid="automation-table" className="w-full min-w-[60rem] text-[0.8125rem]">
              <caption className="sr-only">{l["list.title"]}</caption>
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={th}>{l["list.col_name"]}</th>
                  <th scope="col" className={cn(th, "w-44")}>{l["list.col_group"]}</th>
                  <th scope="col" className={cn(th, "w-28")}>{l["list.col_status"]}</th>
                  <th scope="col" className={cn(th, "w-24 text-right")}>{l["list.col_active"]}</th>
                  <th scope="col" className={cn(th, "w-24 text-right")}>{l["list.col_entered_7d"]}</th>
                  <th scope="col" className={cn(th, "w-24 text-right")}>{l["list.col_sent_7d"]}</th>
                  <th scope="col" className={cn(th, "w-24 text-right")}>{l["list.col_skipped_7d"]}</th>
                  <th scope="col" className={cn(th, "w-24 text-right")}>{l["list.col_failed_7d"]}</th>
                  <th scope="col" className={cn(th, "w-40")}>{l["list.col_last_run"]}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => [
                  !category && r.category !== rows[i - 1]?.category ? (
                    <tr key={`category-${r.category}`} data-category-heading={r.category} className="border-b border-border bg-[#faf9f6]">
                      <th scope="colgroup" colSpan={COLS} className={cn(th, "text-foreground")}>
                        {l[`list.category.${r.category}`] ?? r.category}
                      </th>
                    </tr>
                  ) : null,
                  <tr key={r.id} data-slug={r.slug} className={rowClass}>
                    <td className={td}>
                      <span className="grid leading-tight">
                        <Link href={`/admin/automations/${r.id}`} className={cn(rowLink, "font-semibold hover:underline")}>
                          {r.name}
                        </Link>
                        <span className="font-mono text-[0.6875rem] text-muted-foreground">
                          {r.slug} · {r.currentVersion ? fill(l["list.version_n"], { version: r.currentVersion }) : l["list.no_version"]}
                        </span>
                      </span>
                    </td>
                    <td className={td}>
                      <span className="flex items-center gap-1.5">
                        {r.groupName}
                        {r.groupIsExclusive ? <StatusPill tone="muted">{l["list.exclusive"]}</StatusPill> : null}
                      </span>
                    </td>
                    <td className={td}>
                      <span data-status={r.status} data-testid="automation-status">
                        <StatusPill tone={STATUS_TONE[r.status]}>{l[`status.${r.status}`] ?? r.status}</StatusPill>
                      </span>
                    </td>
                    <td className={cn(td, "text-right font-semibold tabular-nums")}>{r.activeCount}</td>
                    <td className={cn(td, "text-right tabular-nums")}>{r.entered7d}</td>
                    <td className={cn(td, "text-right tabular-nums")}>{r.sent7d}</td>
                    <td className={cn(td, "text-right tabular-nums")}>{r.skipped7d}</td>
                    <td className={cn(td, "text-right tabular-nums", r.failed7d > 0 && "font-semibold text-[var(--status-bad)]")} data-failed={r.failed7d > 0 ? "true" : undefined}>
                      {r.failed7d}
                    </td>
                    <td className={cn(td, "whitespace-nowrap text-muted-foreground")}>{r.lastRunAt ? formatDateTime(r.lastRunAt, locale) : l["list.never"]}</td>
                  </tr>,
                ])}
              </tbody>
            </table>
          </div>
        </Surface>
      )}
    </div>
  );
}
