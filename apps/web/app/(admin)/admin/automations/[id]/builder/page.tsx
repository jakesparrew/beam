import Link from "next/link";
import { notFound } from "next/navigation";
import { ROLE_KEYS } from "@beam/db/schema";
import { Alert, AlertDescription } from "@beam/ui";
import { definitionToGraph, type Definition } from "@beam/core/automation";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import {
  automationLabels,
  countMigratableEnrolments,
  eventKindOptions,
  getAutomation,
  listAutomationOptions,
  listSegmentOptions,
  listTagKeys,
  listTemplateOptions,
} from "@/modules/automation/queries";
import { AutomationHeader } from "@/modules/automation/ui/automation-table";
import { BuilderCanvas } from "@/modules/automation/ui/builder/canvas";

const LABEL_PREFIXES = ["builder", "editor", "publish", "issue", "errors", "purpose", "status", "detail", "list", "common"] as const;

/** A draft the flow can show: a trigger object and a list of steps that each have a key and a type. */
function isFlowShaped(d: unknown): d is Definition {
  if (!d || typeof d !== "object" || Array.isArray(d)) return false;
  const o = d as { trigger?: unknown; steps?: unknown };
  if (!o.trigger || typeof o.trigger !== "object" || !Array.isArray(o.steps)) return false;
  return o.steps.every((s: unknown) => !!s && typeof s === "object" && typeof (s as { key?: unknown }).key === "string" && typeof (s as { type?: unknown }).type === "string");
}

/**
 * `/admin/automations/[id]/builder` (R4, automation-P10; `automations.write`, Publish needs
 * `automations.publish`), automation spec 5: the visual workflow builder over the same draft as
 * the form editor. A draft that is not flow-shaped (broken JSON saved in the JSON tab) shows a
 * link back to the form editor instead; an archived automation opens read-only.
 */
export default async function AutomationBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireStaff({ permission: "automations.write" });
  const { id } = await params;
  const db = await getAppDb();
  const detail = await getAutomation(db, { id });
  if (!detail) notFound();
  const a = detail.automation;
  const locale = await adminLocale();
  const l = automationLabels(locale, LABEL_PREFIXES);
  const [templates, tags, segments, automations, migratable] = await Promise.all([
    listTemplateOptions(db),
    listTagKeys(db),
    listSegmentOptions(db),
    listAutomationOptions(db),
    countMigratableEnrolments(db, a.id),
  ]);
  const archived = a.status === "archived";
  const draft: unknown = a.draftDefinition ?? detail.currentVersion?.definition ?? null;
  return (
    <div className="grid gap-6">
      <AutomationHeader id={a.id} name={a.name} slug={a.slug} status={a.status} current="builder" l={l} />
      <div className="grid gap-1">
        <h2 className="text-lg font-semibold">{l["builder.title"]}</h2>
        <p className="text-sm text-muted-foreground">{l["builder.intro"]}</p>
      </div>
      {isFlowShaped(draft) ? (
        <BuilderCanvas
          automation={{ id: a.id, slug: a.slug, name: a.name }}
          initialGraph={definitionToGraph(draft)}
          savedIssues={detail.draftIssues}
          options={{
            tags,
            segments: segments.map((s) => ({ id: s.id, name: s.name })),
            eventKinds: eventKindOptions(),
            templates,
            automations: automations.filter((x) => x.id !== a.id && x.status !== "archived").map((x) => ({ slug: x.slug, name: x.name })),
            roles: ROLE_KEYS.filter((r) => r !== "external_partner"),
          }}
          migratableCount={migratable}
          canEdit={!archived}
          canPublish={!archived && hasPermission(actor, "automations.publish")}
          labels={l}
        />
      ) : (
        <Alert data-testid="builder-unreadable">
          <AlertDescription className="grid gap-2">
            <span>{l["builder.unreadable"]}</span>
            <Link href={`/admin/automations/${a.id}/edit`} className="underline">
              {l["builder.open_form"]}
            </Link>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
