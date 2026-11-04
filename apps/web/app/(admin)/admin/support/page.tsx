import Link from "next/link";
import { EmptyState } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, reportProblemLabels, translator } from "@/lib/i18n";
import { getSetting } from "@/lib/settings";
import { catalogueSection, listSupportRequests } from "@/modules/platform/queries";
import { ReportProblemButton } from "@/modules/platform/ui/support-form";
import { SupportTable } from "@/modules/platform/ui/support-table";

/**
 * `/admin/support` (any staff): the problems I reported (reference, title, severity, status,
 * received, due, responded) and the "Report a problem" button, the same dialog as the user menu (PL-86, PL-87).
 */
export default async function MySupportPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const actor = await requireStaff();
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string) => tr(`platform.support.${k}`);
  const db = await getAppDb();
  const [{ rows, nextCursor }, support] = await Promise.all([
    listSupportRequests(db, { mineUserId: actor.userId, cursor: sp.cursor ?? null }),
    getSetting(db, "support") as Promise<{ emergency_phone: string }>,
  ]);

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-2">
          <h1 className="text-2xl font-semibold">{t("mine_title")}</h1>
          <p className="text-muted-foreground">{t("mine_intro")}</p>
        </div>
        <ReportProblemButton label={tr("platform.shell.report_problem")} reportLabels={reportProblemLabels(tr, locale)} emergencyPhone={support.emergency_phone} />
      </header>
      {rows.length === 0 ? (
        <EmptyState title={t("empty_mine")} />
      ) : (
        <SupportTable
          rows={rows.map((r) => ({
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
          }))}
          labels={catalogueSection(locale, "platform.support")}
          errors={catalogueSection(locale, "platform.errors")}
          locale={locale}
          manage={false}
        />
      )}
      {nextCursor ? (
        <Link href={`/admin/support?cursor=${encodeURIComponent(nextCursor)}`} className="text-sm underline">
          {tr("platform.table.next")}
        </Link>
      ) : null}
    </div>
  );
}
