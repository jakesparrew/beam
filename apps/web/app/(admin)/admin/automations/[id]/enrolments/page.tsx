import { notFound } from "next/navigation";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { automationLabels, canViewAutomations, getAutomation, listEnrolments, type EnrolmentStatus } from "@/modules/automation/queries";
import { AutomationHeader } from "@/modules/automation/ui/automation-table";
import { EnrolmentFilters, EnrolmentTable } from "@/modules/automation/ui/run-log";

const STATUSES: readonly string[] = ["active", "completed", "exited"];

/**
 * `/admin/automations/[id]/enrolments` (as the list + `persons.read`), automation spec 5: person
 * (link to the person page), status, source, version, entered, next step and due, end reason;
 * filter by status; keyset paging. With `automations.move_person` an active row has Exit
 * (`exitEnrolment`, A-38: the dialog asks for an optional note).
 */
export default async function AutomationEnrolmentsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ status?: string; cursor?: string }> }) {
  const actor = await requireStaff({ permission: "persons.read" });
  if (!canViewAutomations(actor) || !hasPermission(actor, "persons.read")) notFound();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const db = await getAppDb();
  const detail = await getAutomation(db, { id });
  if (!detail) notFound();
  const a = detail.automation;
  const locale = await adminLocale();
  const canExit = hasPermission(actor, "automations.move_person");
  const l = automationLabels(locale, ["enrolments", "enrolment_status", "source", "end_reason", "detail", "status", "common", ...(canExit ? (["panel", "errors"] as const) : [])]);
  const status = sp.status && STATUSES.includes(sp.status) ? (sp.status as EnrolmentStatus) : undefined;
  const page = await listEnrolments(db, { automationId: a.id, ...(status ? { status } : {}), ...(sp.cursor ? { cursor: sp.cursor } : {}), limit: 50 });
  const base = `/admin/automations/${a.id}/enrolments`;
  const moreHref = page.nextCursor ? `${base}?${new URLSearchParams({ ...(status ? { status } : {}), cursor: page.nextCursor }).toString()}` : null;
  return (
    <div className="grid gap-6">
      <AutomationHeader id={a.id} name={a.name} slug={a.slug} status={a.status} current="enrolments" l={l} />
      <EnrolmentFilters action={base} l={l} status={status} />
      <EnrolmentTable rows={page.rows} l={l} locale={locale} moreHref={moreHref} {...(canExit ? { exit: { automationName: a.name } } : {})} />
    </div>
  );
}
