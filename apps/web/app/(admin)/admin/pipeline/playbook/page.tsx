import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@beam/ui";
import { ROLE_KEYS } from "@beam/db/schema";
import type { LocalizedText } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { flag } from "@/lib/flags";
import { adminLocale, translator } from "@/lib/i18n";
import { listPlaybookStages } from "@/modules/crm/queries";
import { PlaybookForm, type PlaybookFormLabels } from "@/modules/crm/ui/pipeline/playbook-form";

/** `/admin/pipeline/playbook` (view `crm.b2b`, edit `settings.write`; flag `ff_crm_pipeline`), crm spec 5.1. */
export default async function PlaybookPage({ searchParams }: { searchParams: Promise<{ pipeline?: string }> }) {
  const actor = await requireStaff({ permission: "crm.b2b" });
  if (!(await flag("ff_crm_pipeline", actor))) notFound();
  const sp = await searchParams;
  const pipeline = sp.pipeline === "b2c" ? "b2c" : "b2b";
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const canEdit = hasPermission(actor, "settings.write");
  const stages = await listPlaybookStages(db, pipeline);
  const f = (k: string) => tr(`crm.playbook.form.${k}`);
  const roles = ROLE_KEYS.filter((r) => r !== "external_partner");
  const labels: PlaybookFormLabels = {
    name: f("name"),
    requiredAction: f("required_action"),
    ownerRole: f("owner_role"),
    deadlineDays: f("deadline_days"),
    defaultProbability: f("default_probability"),
    automationSlug: f("automation_slug"),
    templateSlug: f("template_slug"),
    humanCommunication: f("human_communication"),
    escalationAfterDays: f("escalation_after_days"),
    escalationNotifyRole: f("escalation_notify_role"),
    escalationCreateTask: f("escalation_create_task"),
    kpiName: f("kpi_name"),
    kpiTarget: f("kpi_target"),
    kpiUnit: f("kpi_unit"),
    sortOrder: f("sort_order"),
    isActive: f("is_active"),
    none: f("none"),
    save: tr("crm.common.save"),
    saving: tr("crm.common.saving"),
    saved: f("saved"),
    error: f("error"),
    missingLocales: f("missing_locales"),
    localized: {
      locales: { "nl-BE": tr("crm.enums.locale.nl_BE"), "fr-BE": tr("crm.enums.locale.fr_BE"), en: tr("crm.enums.locale.en") },
      missing: tr("crm.common.required"),
      complete: tr("crm.common.complete"),
    },
    roles: Object.fromEntries(roles.map((r) => [r, tr(`platform.roles.${r}`)])),
    units: Object.fromEntries((["count", "pct", "cents", "days"] as const).map((u) => [u, tr(`crm.enums.kpi_unit.${u}`)])),
  };
  const stageName = (key: string, name: LocalizedText) =>
    name[locale]?.trim() || (pipeline === "b2b" ? tr(`crm.enums.opportunity_stage.${key}`) : tr(`ops.stage.${key}`));

  return (
    <div className="grid gap-6">
      <Link href="/admin/pipeline" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        {tr("crm.pipeline.detail.back")}
      </Link>
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold">{tr("crm.playbook.title")}</h1>
        <p className="text-sm text-muted-foreground">{tr("crm.playbook.description")}</p>
        {!canEdit ? <p className="text-sm text-muted-foreground">{tr("crm.playbook.read_only")}</p> : null}
      </header>
      <nav className="flex gap-2" aria-label={tr("crm.playbook.title")}>
        {(["b2b", "b2c"] as const).map((p) => (
          <Link
            key={p}
            href={`/admin/pipeline/playbook?pipeline=${p}`}
            aria-current={p === pipeline ? "page" : undefined}
            className={`rounded-md px-3 py-1.5 text-sm ${p === pipeline ? "bg-primary text-primary-foreground" : "border"}`}
          >
            {tr(`crm.enums.playbook_pipeline.${p}`)}
          </Link>
        ))}
      </nav>
      {stages.length === 0 ? <p className="text-sm text-muted-foreground">{tr("crm.playbook.none_defined")}</p> : null}
      <div className="grid gap-4">
        {stages.map((s) => (
          <Card key={s.id}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground tabular-nums">{s.sortOrder}</span>
                {stageName(s.stageKey, s.name)}
                <code className="text-xs text-muted-foreground">{s.stageKey}</code>
                {!s.isActive ? <Badge variant="secondary">{tr("crm.playbook.inactive")}</Badge> : null}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <PlaybookForm
                canEdit={canEdit}
                roles={roles}
                labels={labels}
                initial={{
                  pipeline: s.pipeline,
                  stageKey: s.stageKey,
                  sortOrder: s.sortOrder,
                  name: s.name,
                  requiredAction: s.requiredAction,
                  ownerRole: s.ownerRole,
                  deadlineDays: s.deadlineDays,
                  defaultProbabilityPct: s.defaultProbabilityPct,
                  automationSlug: s.automatedCommunication.automation_slug ?? "",
                  templateSlug: s.automatedCommunication.template_slug ?? "",
                  humanCommunication: s.humanCommunication ?? {},
                  escalationAfterDays: s.escalation.after_days ?? null,
                  escalationNotifyRole: s.escalation.notify_role ?? "",
                  escalationCreateTask: s.escalation.create_task !== false,
                  kpiName: s.kpi.name ?? {},
                  kpiTarget: s.kpi.target ?? null,
                  kpiUnit: s.kpi.unit ?? "",
                  isActive: s.isActive,
                }}
              />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
