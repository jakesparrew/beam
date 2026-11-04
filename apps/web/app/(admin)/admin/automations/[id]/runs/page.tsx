import { notFound } from "next/navigation";
import type { AutomationRunOutcome } from "@beam/core/automation";
import { AUTOMATION_RUN_OUTCOMES } from "@beam/db/schema";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { automationLabels, canViewAutomations, getAutomation, listRuns } from "@/modules/automation/queries";
import { AutomationHeader } from "@/modules/automation/ui/automation-table";
import { RunFilters, RunLog } from "@/modules/automation/ui/run-log";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A `YYYY-MM-DD` filter day as a Europe/Brussels day boundary (start, or the end of the day). */
function brusselsDay(value: string | undefined, end: boolean): Date | undefined {
  if (!value || !DATE_RE.test(value)) return undefined;
  const utc = new Date(`${value}T00:00:00Z`);
  const offsetPart = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", timeZoneName: "longOffset" }).formatToParts(utc).find((p) => p.type === "timeZoneName")?.value ?? "GMT+01:00";
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(offsetPart);
  const offsetMin = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 60;
  const start = new Date(utc.getTime() - offsetMin * 60_000);
  return end ? new Date(start.getTime() + 86_400_000 - 1) : start;
}

/**
 * `/admin/automations/[id]/runs` (as the list + `persons.read`), automation spec 5: the run log
 * with time, person, step, outcome badge, reason, email status and task; filters outcome and
 * date range (Brussels days); keyset paging.
 */
export default async function AutomationRunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ outcome?: string; from?: string; to?: string; cursor?: string }>;
}) {
  const actor = await requireStaff({ permission: "persons.read" });
  if (!canViewAutomations(actor) || !hasPermission(actor, "persons.read")) notFound();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const db = await getAppDb();
  const detail = await getAutomation(db, { id });
  if (!detail) notFound();
  const a = detail.automation;
  const locale = await adminLocale();
  const l = automationLabels(locale, ["runs", "outcome", "end_reason", "enrolments", "detail", "status", "common"]);
  const outcome = sp.outcome && (AUTOMATION_RUN_OUTCOMES as readonly string[]).includes(sp.outcome) ? (sp.outcome as AutomationRunOutcome) : undefined;
  const from = brusselsDay(sp.from, false);
  const to = brusselsDay(sp.to, true);
  const page = await listRuns(db, { automationId: a.id, ...(outcome ? { outcome } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), ...(sp.cursor ? { cursor: sp.cursor } : {}), limit: 50 });
  const base = `/admin/automations/${a.id}/runs`;
  const keep = { ...(outcome ? { outcome } : {}), ...(from && sp.from ? { from: sp.from } : {}), ...(to && sp.to ? { to: sp.to } : {}) };
  const moreHref = page.nextCursor ? `${base}?${new URLSearchParams({ ...keep, cursor: page.nextCursor }).toString()}` : null;
  return (
    <div className="grid gap-6">
      <AutomationHeader id={a.id} name={a.name} slug={a.slug} status={a.status} current="runs" l={l} />
      <RunFilters action={base} l={l} value={{ outcome, from: keep.from, to: keep.to }} />
      <RunLog rows={page.rows} l={l} locale={locale} moreHref={moreHref} />
    </div>
  );
}
