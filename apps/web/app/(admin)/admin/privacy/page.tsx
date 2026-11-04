import Link from "next/link";
import type { Route } from "next";
import { Badge, Button, buttonVariants } from "@beam/ui";
import { PRIVACY_KINDS, PRIVACY_STATUSES, brusselsDate, type PrivacyKind, type PrivacyStatus } from "@beam/core/ops";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listPrivacyRequests } from "@/modules/ops/privacy/queries";

/**
 * `/admin/privacy` (ops spec 5, rule 58): privacy requests with kind, status, due date (red with a
 * "due soon" label under 5 days, so colour is never the only signal), requested by and manual
 * follow-up; filters by status and kind; 50 per page. `privacy.run`, `persons.erase` or
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
  const canCreate = hasPermission(actor, "persons.erase") || hasPermission(actor, "persons.export") || hasPermission(actor, "persons.write");

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{tr("ops.privacy.title")}</h1>
        {canCreate ? (
          <Link href="/admin/privacy/new" className={buttonVariants({ size: "sm" })}>
            {tr("ops.privacy.new")}
          </Link>
        ) : null}
      </div>
      <form method="get" className="flex flex-wrap items-end gap-3" aria-label={tr("platform.table.filters")}>
        <label className="grid gap-1 text-sm">
          <span>{tr("platform.jobs.filter_status")}</span>
          <select name="status" defaultValue={status ?? ""} className="h-10 rounded-md border bg-background px-2">
            <option value="">{tr("platform.integrations.all_statuses")}</option>
            {PRIVACY_STATUSES.map((s) => (
              <option key={s} value={s}>
                {tr(`ops.privacy.status.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span>{tr("platform.jobs.filter_kind")}</span>
          <select name="kind" defaultValue={kind ?? ""} className="h-10 rounded-md border bg-background px-2">
            <option value="">{tr("platform.incidents.all")}</option>
            {PRIVACY_KINDS.map((k) => (
              <option key={k} value={k}>
                {tr(`ops.privacy.kind.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="outline" size="sm">
          {tr("platform.jobs.apply_filters")}
        </Button>
      </form>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tr("ops.privacy.empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2">{tr("platform.audit.person_id")}</th>
                <th className="px-3 py-2">{tr("platform.jobs.col_kind")}</th>
                <th className="px-3 py-2">{tr("platform.jobs.col_status")}</th>
                <th className="px-3 py-2">{tr("ops.privacy.due_on", { date: "" }).trim()}</th>
                <th className="px-3 py-2">{tr("platform.users.col_actor")}</th>
                <th className="px-3 py-2">{tr("platform.jobs.created_at")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => {
                const left = daysUntil(r.dueOn, today);
                const open = r.status !== "done" && r.status !== "cancelled";
                const soon = open && left < DUE_SOON_DAYS;
                return (
                  <tr key={r.id} className="border-t">
                    <td className="px-3 py-2">
                      <Link href={`/admin/privacy/${r.id}` as Route} className="font-medium underline-offset-4 hover:underline">
                        {r.personName ?? r.personId.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{tr(`ops.privacy.kind.${r.kind}`)}</td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap gap-1">
                        <Badge variant={r.status === "failed" ? "destructive" : r.status === "done" ? "success" : "secondary"}>{tr(`ops.privacy.status.${r.status}`)}</Badge>
                        {r.needsManualFollowup ? <Badge variant="destructive">{tr("ops.privacy.manual_followup")}</Badge> : null}
                      </span>
                    </td>
                    <td className={soon ? "px-3 py-2 font-medium text-destructive" : "px-3 py-2"}>
                      {dateFmt.format(new Date(`${r.dueOn}T12:00:00Z`))}
                      {soon ? <span className="ml-2 text-xs">({tr("ops.privacy.due_soon")})</span> : null}
                    </td>
                    <td className="px-3 py-2">{tr(`ops.privacy.requested_by.${r.requestedBy}`)}</td>
                    <td className="px-3 py-2">{dateFmt.format(r.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {total > pageSize ? (
        <nav className="flex gap-2" aria-label={tr("platform.table.filters")}>
          {page > 1 ? (
            <Link href={pageHref(page - 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
              {tr("platform.table.previous")}
            </Link>
          ) : null}
          {page * pageSize < total ? (
            <Link href={pageHref(page + 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
              {tr("platform.table.next")}
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
