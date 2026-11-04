import Link from "next/link";
import { EmptyState } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { catalogueSection, listIncidents, listStaffUsers, listSupportRequests, type SupportRow, type SupportStatus } from "@/modules/platform/queries";
import { LogSupportForm } from "@/modules/platform/ui/support-form";
import { SupportTable } from "@/modules/platform/ui/support-table";

const STATUSES = ["open", "responded", "resolved", "closed"] as const;
const SEVERITIES = ["critical", "high", "normal", "improvement"] as const;

type Search = { status?: string; severity?: string; cursor?: string };

/** Serialisable rows for the client table. */
function supportRows(rows: SupportRow[]) {
  return rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    severity: r.severity,
    channel: r.channel,
    title: r.title,
    status: r.status,
    receivedAt: r.receivedAt.toISOString(),
    responseDueAt: r.responseDueAt.toISOString(),
    firstResponseAt: r.firstResponseAt ? r.firstResponseAt.toISOString() : null,
    isBreached: r.isBreached,
    reporter: r.reporter,
    assignee: r.assignee,
  }));
}

/**
 * `/admin/system/support` (`system.jobs`): the support register from `v_support_sla` (due date red
 * when breached), default filter open and responded; log a request received by email, Slack,
 * WhatsApp or phone (PL-87) and update status, note, assignee and linked incident.
 */
export default async function SupportRegisterPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireStaff({ permission: "system.jobs" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string) => tr(`platform.support.${k}`);
  const db = await getAppDb();
  const status: SupportStatus[] =
    sp.status === "all" ? [] : (STATUSES as readonly string[]).includes(sp.status ?? "") ? [sp.status as SupportStatus] : ["open", "responded"];
  const severity = (SEVERITIES as readonly string[]).includes(sp.severity ?? "") ? (sp.severity as (typeof SEVERITIES)[number]) : undefined;
  const [{ rows, nextCursor }, staff, incidents] = await Promise.all([
    listSupportRequests(db, { status, ...(severity ? { severity } : {}), cursor: sp.cursor ?? null }),
    listStaffUsers(db, { status: "active" }),
    listIncidents(db),
  ]);
  const labels = catalogueSection(locale, "platform.support");
  const errors = catalogueSection(locale, "platform.errors");
  const staffOptions = staff.rows.map((u) => ({ id: u.id, name: u.name ?? u.email }));
  const filterHref = (s: string) => `/admin/system/support?status=${s}${severity ? `&severity=${severity}` : ""}` as const;
  const next = new URLSearchParams({ ...(sp.status ? { status: sp.status } : {}), ...(severity ? { severity } : {}), ...(nextCursor ? { cursor: nextCursor } : {}) });

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">{t("register_title")}</h1>
        <p className="text-muted-foreground">{t("register_intro")}</p>
      </header>
      <nav aria-label={t("col_status")} className="flex flex-wrap gap-3 text-sm">
        <Link href="/admin/system/support" className={sp.status ? "underline" : "font-semibold"}>
          {t("filter_open")}
        </Link>
        {STATUSES.map((s) => (
          <Link key={s} href={filterHref(s)} className={sp.status === s ? "font-semibold" : "underline"}>
            {t(`status_${s}`)}
          </Link>
        ))}
        <Link href={filterHref("all")} className={sp.status === "all" ? "font-semibold" : "underline"}>
          {t("filter_all")}
        </Link>
      </nav>
      {rows.length === 0 ? (
        <EmptyState title={t("empty_register")} />
      ) : (
        <SupportTable rows={supportRows(rows)} labels={labels} errors={errors} locale={locale} manage staff={staffOptions} incidents={incidents.map((i) => ({ id: i.id, title: i.title }))} />
      )}
      {nextCursor ? (
        <Link href={`/admin/system/support?${next.toString()}`} className="text-sm underline">
          {tr("platform.table.next")}
        </Link>
      ) : null}
      <LogSupportForm labels={labels} errors={errors} staff={staffOptions} />
    </div>
  );
}
