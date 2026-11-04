import Link from "next/link";
import { formatDateTime } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { creditsLabels, listReconciliationRuns } from "@/modules/credits/queries";
import { ReconciliationList, RunReconcileButton, type ReconcileRunView } from "@/modules/credits/ui/reconciliation-list";

/** `/admin/credits/reconciliation` (`credits.read`; "Run now" needs `credits.adjust`): the last 30 runs with findings. */
export default async function ReconciliationPage() {
  const actor = await requireStaff({ permission: "credits.read" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const r = (k: string, p?: Record<string, string | number>) => tr(`credits.admin.reconciliation.${k}`, p);
  const runs = await listReconciliationRuns(await getAppDb(), { limit: 30 });
  const checkName = (c: string) => {
    const key = `credits.enum.reconcile_check.${c}`;
    try {
      return tr(key);
    } catch {
      return c;
    }
  };
  const show = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v as string | number | boolean));
  const view: ReconcileRunView[] = runs.map((run) => {
    const status = run.status ?? "running";
    return {
      id: run.id,
      startedText: formatDateTime(run.startedAt, locale, "short"),
      status,
      statusText: tr(`credits.enum.reconcile_status.${status}`),
      checkedGrants: run.checkedGrants,
      checkedBookings: run.checkedBookings,
      fixedText: run.fixed.length ? r("fixed", { count: run.fixed.length }) : null,
      findings: run.findings.slice(0, 50).map((f) => ({
        text: r("finding", { check: checkName(String(f.check)), expected: show(f.expected), actual: show(f.actual) }),
        ...(f.grant_id ? { grantId: f.grant_id } : {}),
        ...(f.membership_id ? { membershipId: f.membership_id } : {}),
        ...(f.booking_id ? { bookingId: f.booking_id } : {}),
      })),
    };
  });
  const labels = creditsLabels(locale, ["admin.common", "admin.reconciliation", "errors"]);
  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <Link href="/admin/credits" className="text-sm text-muted-foreground hover:underline">
          {tr("credits.admin.grant.back")}
        </Link>
        <h1 className="text-2xl font-semibold">{r("title")}</h1>
        <p className="max-w-prose text-muted-foreground">{r("intro")}</p>
      </header>
      {hasPermission(actor, "credits.adjust") ? <RunReconcileButton labels={labels} /> : null}
      <ReconciliationList runs={view} labels={labels} />
    </div>
  );
}
