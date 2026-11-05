import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@beam/ui";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { automationLabels, canViewAutomations, listAutomations, listGroupOptions, type AutomationStatus } from "@/modules/automation/queries";
import { AutomationFilters, AutomationTable } from "@/modules/automation/ui/automation-table";

const STATUSES: readonly string[] = ["draft", "active", "paused", "archived"];

/**
 * `/admin/automations` (automation spec 5; `automations.write` or `reports.read`, New needs
 * `automations.write`): every automation with group, status, version and the last 7 days from
 * `v_automation_stats`; filters status, group and search. Links to the groups, and with
 * `automations.publish` to the frequency rules and the conflict report.
 */
export default async function AutomationsPage({ searchParams }: { searchParams: Promise<{ status?: string; group?: string; q?: string }> }) {
  const actor = await requireStaff();
  if (!canViewAutomations(actor)) notFound();
  const sp = await searchParams;
  const locale = await adminLocale();
  const l = automationLabels(locale, ["list", "status", "common"]);
  const db = await getAppDb();
  const status = sp.status && STATUSES.includes(sp.status) ? (sp.status as AutomationStatus) : undefined;
  const [rows, groups] = await Promise.all([listAutomations(db, { status, groupKey: sp.group || undefined, q: sp.q || undefined }), listGroupOptions(db)]);
  const canWrite = hasPermission(actor, "automations.write");
  // The rules (A-32) and conflict report (A-37) screens need `automations.publish`.
  const canPublish = hasPermission(actor, "automations.publish");
  const newButton = canWrite ? (
    <Button asChild>
      <Link href="/admin/automations/new">{l["list.new"]}</Link>
    </Button>
  ) : undefined;
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{l["list.title"]}</h1>
          <p className="text-sm text-muted-foreground">{l["list.description"]}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link href="/admin/automations/groups">{l["list.groups"]}</Link>
          </Button>
          {canPublish ? (
            <>
              <Button variant="outline" asChild>
                <Link href="/admin/automations/rules">{l["list.rules"]}</Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href="/admin/automations/conflicts">{l["list.conflicts"]}</Link>
              </Button>
            </>
          ) : null}
          {newButton}
        </div>
      </div>
      <AutomationFilters l={l} groups={groups} value={{ status, group: sp.group, q: sp.q }} />
      <AutomationTable rows={rows} l={l} locale={locale} emptyAction={newButton} filtered={!!(status || sp.group || sp.q)} />
    </div>
  );
}
