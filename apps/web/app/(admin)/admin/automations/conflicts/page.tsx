import Link from "next/link";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { automationLabels, getConflictReport } from "@/modules/automation/queries";
import { ConflictPeriodSwitch, ConflictReportView } from "@/modules/automation/ui/conflict-report";

/**
 * `/admin/automations/conflicts` (R2, automation spec 5, automation-P7; `automations.publish`):
 * which journeys block (`skipped_exclusive`) or supersede which in the last 7 or 30 days, with
 * counts and sample persons (names only with `persons.read`). Empty: "No conflicts in this period".
 */
export default async function AutomationConflictsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const actor = await requireStaff({ permission: "automations.publish" });
  const sp = await searchParams;
  const days = sp.days === "30" ? 30 : 7;
  const locale = await adminLocale();
  const l = automationLabels(locale, ["conflicts", "common"]);
  const canSeePersons = hasPermission(actor, "persons.read");
  const report = await getConflictReport(await getAppDb(), { days, includePersons: canSeePersons });
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <Link href="/admin/automations/groups" className="text-sm text-muted-foreground underline-offset-2 hover:underline">
          {l["common.back"]}
        </Link>
        <h1 className="text-2xl font-semibold">{l["conflicts.title"]}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{l["conflicts.description"]}</p>
      </div>
      <ConflictPeriodSwitch days={days} labels={l} />
      <ConflictReportView report={report} canSeePersons={canSeePersons} labels={l} locale={locale} />
    </div>
  );
}
