import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@beam/ui";
import { formatDate, formatDateTime, formatMoney, type Locale, type LocalizedText } from "@beam/core/i18n";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { flag } from "@/lib/flags";
import { adminLocale, translator } from "@/lib/i18n";
import { getOpportunity, getOpportunityFormOptions, getTimeline } from "@/modules/crm/queries";
import { cardView, opportunityFormLabels, stageDialogLabels, weighted } from "@/modules/crm/pipeline/queries";
import { toTimelineRows } from "@/modules/crm/timeline/queries";
import { OpportunityForm } from "@/modules/crm/ui/pipeline/board";
import { MoveStageButton } from "@/modules/crm/ui/pipeline/stage-dialog";

const text = (t: LocalizedText | null | undefined, locale: Locale) => t?.[locale]?.trim() || null;

/** `/admin/pipeline/[id]` (`crm.b2b`, flag `ff_crm_pipeline`), crm spec 5.1. */
export default async function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireStaff({ permission: "crm.b2b" });
  if (!(await flag("ff_crm_pipeline", actor))) notFound();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const opp = await getOpportunity(db, id);
  if (!opp) notFound();
  const d = (k: string, p?: Record<string, string | number>) => tr(`crm.pipeline.detail.${k}`, p);
  const money = (c: number) => formatMoney(c, locale, { hideZeroDecimals: true });

  const [options, companyTimeline, contactTimeline] = await Promise.all([
    getOpportunityFormOptions(db),
    getTimeline(db, { companyId: opp.companyId, limit: 30 }).catch(() => null),
    opp.primaryContactPersonId ? getTimeline(db, { personId: opp.primaryContactPersonId, limit: 30 }).catch(() => null) : Promise.resolve(null),
  ]);
  const items = [...(companyTimeline?.items ?? []), ...(contactTimeline?.items ?? [])]
    .filter((item, i, all) => all.findIndex((x) => x.id === item.id) === i)
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
    .slice(0, 30);
  const activity = await toTimelineRows(db, items, locale);
  const card = cardView(opp, locale);
  const pb = opp.playbook;
  const role = (key: string | undefined) => (key ? tr(`platform.roles.${key}`) : "—");

  return (
    <div className="grid gap-6">
      <Link href="/admin/pipeline" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        {d("back")}
      </Link>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <p className="text-sm text-muted-foreground">
            <Link href={`/admin/companies/${opp.companyId}`} className="underline-offset-4 hover:underline">
              {opp.companyName}
            </Link>
          </p>
          <h1 className="text-2xl font-semibold">{opp.title}</h1>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">{tr(`crm.enums.opportunity_stage.${opp.stage}`)}</Badge>
            {opp.isStalled ? <Badge variant="destructive">{tr("crm.pipeline.card.stalled")}</Badge> : null}
          </div>
        </div>
        {card.allowed.length ? (
          <MoveStageButton target={{ id: opp.id, version: opp.version, stage: opp.stage, title: opp.title }} allowed={card.allowed} labels={stageDialogLabels(tr)} buttonLabel={d("move")} />
        ) : null}
      </header>

      <dl className="grid gap-3 sm:grid-cols-4">
        {[
          [d("value"), money(opp.valueCents)],
          [d("probability"), `${opp.probabilityPct} %`],
          [d("weighted"), money(weighted(opp.valueCents, opp.probabilityPct))],
          [d("stage_entered"), formatDate(opp.stageEnteredAt, locale)],
          [d("contact"), opp.contactName ?? tr("crm.pipeline.card.no_contact")],
          [tr("crm.pipeline.card.last_contact"), card.lastContact ?? tr("crm.pipeline.card.never")],
          ...(opp.wonAt ? [[d("won_at"), formatDate(opp.wonAt, locale)]] : []),
          ...(opp.lostReason ? [[d("lost_reason"), opp.lostReason]] : []),
        ].map(([label, value]) => (
          <div key={label} className="grid gap-0.5">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-sm font-medium">{value}</dd>
          </div>
        ))}
      </dl>

      <Card>
        <CardHeader>
          <CardTitle>{d("playbook_title")}</CardTitle>
        </CardHeader>
        <CardContent>
          {pb && pb.isActive ? (
            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">{d("required_action")}</dt>
                <dd className="text-sm">{text(pb.requiredAction, locale) ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{d("owner_role")}</dt>
                <dd className="text-sm">{role(pb.ownerRole)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{d("deadline")}</dt>
                <dd className="text-sm">{d("deadline_days", { days: pb.deadlineDays })}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{d("automated")}</dt>
                <dd className="text-sm">{[pb.automatedCommunication.automation_slug, pb.automatedCommunication.template_slug].filter(Boolean).join(" · ") || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{d("human")}</dt>
                <dd className="text-sm whitespace-pre-line">{text(pb.humanCommunication, locale) ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{d("escalation")}</dt>
                <dd className="text-sm">
                  {pb.escalation.after_days !== undefined ? d("escalation_value", { days: pb.escalation.after_days, role: role(pb.escalation.notify_role) }) : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{d("kpi")}</dt>
                <dd className="text-sm">
                  {[text(pb.kpi.name, locale), pb.kpi.target !== undefined ? String(pb.kpi.target) : null, pb.kpi.unit ? tr(`crm.enums.kpi_unit.${pb.kpi.unit}`) : null].filter(Boolean).join(" · ") || "—"}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">{d("no_playbook")}</p>
          )}
        </CardContent>
      </Card>

      <section className="grid gap-3" aria-labelledby="tasks-heading">
        <h2 id="tasks-heading" className="text-lg font-semibold">
          {d("tasks_title")}
        </h2>
        {opp.tasks.length ? (
          <ul className="grid gap-2">
            {opp.tasks.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant={t.status === "open" ? "outline" : "secondary"}>{tr(`crm.enums.task_status.${t.status}`)}</Badge>
                <span className={t.status === "open" ? "font-medium" : "text-muted-foreground line-through"}>{t.title}</span>
                {t.dueAt ? <span className={t.isOverdue ? "text-destructive" : "text-muted-foreground"}>{formatDateTime(t.dueAt, locale)}</span> : null}
                {t.isOverdue ? <Badge variant="destructive">{d("overdue")}</Badge> : null}
                {t.ownerName ? <span className="text-muted-foreground">· {t.ownerName}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{d("no_tasks")}</p>
        )}
        <Link href="/admin/tasks" className="text-sm underline-offset-4 hover:underline">
          {tr("crm.nav.tasks")}
        </Link>
      </section>

      <OpportunityForm
        initial={{
          id: opp.id,
          version: opp.version,
          companyId: opp.companyId,
          title: opp.title,
          primaryContactPersonId: opp.primaryContactPersonId ?? "",
          value: (opp.valueCents / 100).toFixed(2),
          probabilityPct: String(opp.probabilityPct),
          expectedCloseOn: opp.expectedCloseOn ?? "",
          ownerUserId: opp.ownerUserId,
          nextAction: opp.nextAction ?? "",
          nextActionOn: opp.nextActionAt ? opp.nextActionAt.toISOString().slice(0, 10) : "",
          source: opp.source ?? "",
          notes: opp.notes ?? "",
        }}
        companies={options.companies}
        contacts={options.contacts}
        owners={options.owners}
        labels={opportunityFormLabels(tr)}
      />

      <section className="grid gap-3" aria-labelledby="activity-heading">
        <h2 id="activity-heading" className="text-lg font-semibold">
          {d("activity_title")}
        </h2>
        {activity.length ? (
          <ol className="grid gap-2">
            {activity.map((row) => (
              <li key={row.id} className="text-sm">
                <time className="mr-2 text-muted-foreground" dateTime={row.occurredAt}>
                  {row.timeLabel}
                </time>
                {row.summary}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">{d("no_activity")}</p>
        )}
      </section>
    </div>
  );
}
