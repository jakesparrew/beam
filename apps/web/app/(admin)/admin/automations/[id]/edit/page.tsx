import { notFound } from "next/navigation";
import { ROLE_KEYS } from "@beam/db/schema";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import {
  automationLabels,
  countMigratableEnrolments,
  eventKindOptions,
  getAutomation,
  listAutomationOptions,
  listGroupOptions,
  listSegmentOptions,
  listTagKeys,
  listTemplateOptions,
} from "@/modules/automation/queries";
import { AutomationHeader } from "@/modules/automation/ui/automation-table";
import { DefinitionEditor } from "@/modules/automation/ui/definition-editor";

const LABEL_PREFIXES = ["editor", "publish", "issue", "errors", "purpose", "status", "detail", "list", "common"] as const;

/**
 * `/admin/automations/[id]/edit` (`automations.write`; Publish needs `automations.publish`),
 * automation spec 5: the form-based editor over the draft with a JSON tab, live issues beside the
 * fields, Save draft, Validate and the publish dialog. An archived automation opens read-only.
 */
export default async function EditAutomationPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireStaff({ permission: "automations.write" });
  const { id } = await params;
  const db = await getAppDb();
  const detail = await getAutomation(db, { id });
  if (!detail) notFound();
  const a = detail.automation;
  const locale = await adminLocale();
  const l = automationLabels(locale, LABEL_PREFIXES);
  const [templates, tags, segments, automations, groups, migratable] = await Promise.all([
    listTemplateOptions(db),
    listTagKeys(db),
    listSegmentOptions(db),
    listAutomationOptions(db),
    listGroupOptions(db),
    countMigratableEnrolments(db, a.id),
  ]);
  const archived = a.status === "archived";
  const draft = a.draftDefinition ?? detail.currentVersion?.definition ?? null;
  return (
    <div className="grid gap-6">
      <AutomationHeader id={a.id} name={a.name} slug={a.slug} status={a.status} current="edit" l={l} />
      <DefinitionEditor
        automation={{ id: a.id, slug: a.slug, name: a.name, description: a.description, groupKey: detail.group.key, priority: a.priority, isMarketing: a.isMarketing, purpose: a.purpose }}
        draft={draft}
        issues={detail.draftIssues}
        options={{
          tags,
          segments: segments.map((s) => ({ id: s.id, name: s.name })),
          eventKinds: eventKindOptions(),
          templates,
          automations: automations.filter((x) => x.id !== a.id && x.status !== "archived").map((x) => ({ slug: x.slug, name: x.name })),
          roles: ROLE_KEYS.filter((r) => r !== "external_partner"),
        }}
        groups={groups}
        migratableCount={migratable}
        canEdit={!archived}
        canPublish={!archived && hasPermission(actor, "automations.publish")}
        labels={l}
      />
    </div>
  );
}
