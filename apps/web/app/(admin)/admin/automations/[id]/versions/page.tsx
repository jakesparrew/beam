import { notFound } from "next/navigation";
import { formatDateTime } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { automationLabels, canViewAutomations, getAutomation, getVersion, isUuid, listVersions } from "@/modules/automation/queries";
import { AutomationHeader } from "@/modules/automation/ui/automation-table";
import { fill } from "@/modules/automation/ui/outcome-badge";
import { VersionDiff, VersionsTable, type DiffRow } from "@/modules/automation/ui/version-diff";

const json = (v: unknown) => (v === undefined ? undefined : JSON.stringify(v, null, 2));

/**
 * `/admin/automations/[id]/versions` (as the list), automation spec 5: every published version
 * with author and note; two selected versions (`?from=&to=`) show the diff from
 * `diffDefinitions`; "Restore into draft" (`automations.write`) copies a version into the draft.
 */
export default async function AutomationVersionsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string; to?: string }> }) {
  const actor = await requireStaff();
  if (!canViewAutomations(actor)) notFound();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const db = await getAppDb();
  const detail = await getAutomation(db, { id });
  if (!detail) notFound();
  const a = detail.automation;
  const locale = await adminLocale();
  const l = automationLabels(locale, ["versions", "detail", "status", "errors", "common"]);
  const versions = await listVersions(db, { automationId: a.id });

  const toId = isUuid(sp.to) ? sp.to : null;
  const diff = toId ? await getVersion(db, { versionId: toId, ...(isUuid(sp.from) ? { compareToId: sp.from } : {}) }) : null;
  const rows: DiffRow[] = diff && diff.automationId === a.id ? diff.diff.map((c) => ({ path: c.path, kind: c.kind, before: json(c.before), after: json(c.after) })) : [];
  const title = diff
    ? diff.previous
      ? fill(l["versions.diff_title"], { from: diff.previous.version, to: diff.version })
      : fill(l["versions.diff_first"], { version: diff.version })
    : null;

  return (
    <div className="grid gap-6">
      <AutomationHeader id={a.id} name={a.name} slug={a.slug} status={a.status} current="versions" l={l} />
      <VersionsTable
        automationId={a.id}
        versions={versions.map((v) => ({
          id: v.id,
          version: v.version,
          publishedAt: formatDateTime(v.publishedAt, locale),
          authorName: v.authorName,
          changeNote: v.changeNote,
          isCurrent: v.id === a.currentVersionId,
          definition: v.definition,
        }))}
        selected={[sp.from, sp.to].filter(isUuid)}
        canEdit={a.status !== "archived" && hasPermission(actor, "automations.write")}
        labels={l}
      />
      {title && diff?.automationId === a.id ? <VersionDiff title={title} rows={rows} labels={l} /> : null}
    </div>
  );
}
