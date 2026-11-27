import Link from "next/link";
import type { Route } from "next";
import { cn, EmptyState } from "@beam/ui";
import { PRIVACY_KINDS, PRIVACY_STATUSES, brusselsDate, type PrivacyKind, type PrivacyStatus } from "@beam/core/ops";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listPrivacyRequests } from "@/modules/ops/privacy/queries";
import { SecondaryAction, Segmented, StatusPill, Surface, Toolbar, td, th, type Tone } from "@/modules/platform/ui/admin-kit";
import { Disclosure, Field, fieldClass, rowClass, rowLink } from "@/modules/platform/ui/admin-list-kit";
import { PrivacyHeader } from "./privacy-header";

/**
 * `/admin/privacy` (ops spec 5, rule 58), the requests tab of "Privacy & gegevens" (owner review,
 * November 2026): privacy requests with kind, status, due date (red with a
 * "due soon" label under 5 days, so colour is never the only signal), requested by and manual
 * follow-up; kind tabs, status behind "Filters"; 50 per page. `privacy.run`, `persons.erase` or
 * `persons.export`.
 */
const DUE_SOON_DAYS = 5;

const daysUntil = (dueOn: string, today: string) => Math.round((Date.parse(`${dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);

export default async function PrivacyRequestsPage({ searchParams }: { searchParams: Promise<{ status?: string; kind?: string; page?: string }> }) {
  const actor = await requireStaff();
  if (!hasPermission(actor, "privacy.run") && !hasPermission(actor, "persons.erase") && !hasPermission(actor, "persons.export")) await requireStaff({ permission: "privacy.run" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const status = (PRIVACY_STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as PrivacyStatus) : undefined;
  const kind = (PRIVACY_KINDS as readonly string[]).includes(sp.kind ?? "") ? (sp.kind as PrivacyKind) : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const db = await getAppDb();
  const { items, total, pageSize } = await listPrivacyRequests(db, { status, kind, page });
  const today = brusselsDate(new Date());
  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "Europe/Brussels" });
  const pageHref = (p: number) => {
    const q = new URLSearchParams();
    if (status) q.set("status", status);
    if (kind) q.set("kind", kind);
    q.set("page", String(p));
    return `/admin/privacy?${q.toString()}` as Route;
  };

  const href = (patch: Record<string, string | undefined>): Route => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ status, kind, ...patch })) if (v) q.set(k, v);
    const str = q.toString();
    return str ? `/admin/privacy?${str}` : "/admin/privacy";
  };
  const statusTone = (s: PrivacyStatus): Tone => (s === "failed" ? "bad" : s === "done" ? "ok" : s === "cancelled" ? "muted" : "info");

  return (
    <div className="grid gap-4">
      <PrivacyHeader active="requests" actor={actor} tr={tr} />
      <form data-auto-filter="" method="get" aria-label={tr("platform.table.filters")}>
        <Toolbar>
          {kind ? <input type="hidden" name="kind" value={kind} /> : null}
          <Segmented
            label={tr("platform.jobs.filter_kind")}
            items={[{ key: "all", label: tr("platform.incidents.all"), href: href({ kind: undefined }), active: !kind }, ...PRIVACY_KINDS.map((k) => ({ key: k, label: tr(`ops.privacy.kind.${k}`), href: href({ kind: k }), active: kind === k }))]}
          />
          <Disclosure label={tr("platform.table.filters")} count={status ? 1 : 0} clear={status ? { href: href({ status: undefined }), label: tr("platform.integrations.all_statuses") } : null}>
            <Field label={tr("platform.jobs.filter_status")}>
              <select name="status" defaultValue={status ?? ""} className={fieldClass}>
                <option value="">{tr("platform.integrations.all_statuses")}</option>
                {PRIVACY_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {tr(`ops.privacy.status.${s}`)}
                  </option>
                ))}
              </select>
            </Field>
          </Disclosure>
        </Toolbar>
      </form>
      {items.length === 0 ? (
        <EmptyState title={tr("ops.privacy.empty")} />
      ) : (
        <Surface flush>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-[0.8125rem]">
              <caption className="sr-only">{tr("ops.privacy.title")}</caption>
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={th}>{tr("platform.audit.person_id")}</th>
                  <th scope="col" className={cn(th, "w-32")}>{tr("platform.jobs.col_kind")}</th>
                  <th scope="col" className={cn(th, "w-56")}>{tr("platform.jobs.col_status")}</th>
                  <th scope="col" className={cn(th, "w-44")}>{tr("ops.privacy.due_on", { date: "" }).trim()}</th>
                  <th scope="col" className={cn(th, "w-36")}>{tr("platform.users.col_actor")}</th>
                  <th scope="col" className={cn(th, "w-32")}>{tr("platform.jobs.created_at")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => {
                  const left = daysUntil(r.dueOn, today);
                  const open = r.status !== "done" && r.status !== "cancelled";
                  const soon = open && left < DUE_SOON_DAYS;
                  return (
                    <tr key={r.id} className={rowClass}>
                      <td className={td}>
                        <Link href={`/admin/privacy/${r.id}` as Route} className={cn(rowLink, "font-semibold hover:underline")}>
                          {r.personName ?? r.personId.slice(0, 8)}
                        </Link>
                      </td>
                      <td className={td}>{tr(`ops.privacy.kind.${r.kind}`)}</td>
                      <td className={td}>
                        <span className="flex flex-wrap gap-1">
                          <StatusPill tone={statusTone(r.status)}>{tr(`ops.privacy.status.${r.status}`)}</StatusPill>
                          {r.needsManualFollowup ? <StatusPill tone="bad">{tr("ops.privacy.manual_followup")}</StatusPill> : null}
                        </span>
                      </td>
                      <td className={cn(td, "whitespace-nowrap", soon && "font-semibold text-[var(--status-bad)]")}>
                        {dateFmt.format(new Date(`${r.dueOn}T12:00:00Z`))}
                        {soon ? <span className="ml-2 text-[0.75rem]">({tr("ops.privacy.due_soon")})</span> : null}
                      </td>
                      <td className={cn(td, "text-muted-foreground")}>{tr(`ops.privacy.requested_by.${r.requestedBy}`)}</td>
                      <td className={cn(td, "whitespace-nowrap text-muted-foreground")}>{dateFmt.format(r.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Surface>
      )}
      {total > pageSize ? (
        <nav className="flex gap-2" aria-label={tr("platform.table.filters")}>
          {page > 1 ? <SecondaryAction href={pageHref(page - 1)}>{tr("platform.table.previous")}</SecondaryAction> : null}
          {page * pageSize < total ? <SecondaryAction href={pageHref(page + 1)}>{tr("platform.table.next")}</SecondaryAction> : null}
        </nav>
      ) : null}
    </div>
  );
}
