import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, AlertDescription, Badge, Button } from "@beam/ui";
import { brusselsParts, emptyDocument } from "@beam/core/email";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getSegmentSummaries } from "@/modules/crm/api";
import { sendTestEmail } from "@/modules/email/actions";
import { catalogueSection, getCampaign, getTemplate, staffEmailOf } from "@/modules/email/queries";
import { AudiencePicker } from "@/modules/email/ui/campaign/AudiencePicker";
import { CampaignControls } from "@/modules/email/ui/campaign/CampaignControls";
import { CAMPAIGN_STEPS, CampaignStepper, clab, type CampaignStep } from "@/modules/email/ui/campaign/CampaignStepper";
import { ReviewChecklist } from "@/modules/email/ui/campaign/ReviewChecklist";
import { SchedulePanel } from "@/modules/email/ui/campaign/SchedulePanel";
import { BlockEditor } from "@/modules/email/ui/editor/BlockEditor";
import { TestSendDialog } from "@/modules/email/ui/editor/TestSendDialog";

/** `YYYY-MM-DDTHH:mm` of an instant in Brussels (the datetime-local value). */
function localValue(at: Date): string {
  const p = brusselsParts(at);
  return `${p.date}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** The schedule field's start value: the draft's future `scheduled_at`, else the next quarter hour after an hour from now. */
function suggestedStart(scheduledAt: Date | null): string {
  const now = Date.now();
  return localValue(scheduledAt && scheduledAt.getTime() > now ? scheduledAt : new Date(Math.ceil((now + 3600_000) / 900_000) * 900_000));
}

/**
 * `/admin/campaigns/[id]` (edit `email.write`; schedule and controls `campaigns.send`, buttons
 * hidden and server-refused otherwise; `reports.read` reads), email spec section 5: the stepper
 * Content (the block editor of the campaign's template; scheduling publishes the draft),
 * Audience (segment, exclusions, live estimate), Review (checklist with links to fix each item,
 * test send, preview), Schedule (Brussels date and time or Send now), then the sending progress
 * with links to the recipients list and the campaign report.
 */
export default async function CampaignPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ step?: string }> }) {
  const actor = await requireStaff();
  const canWrite = hasPermission(actor, "email.write");
  if (!canWrite && !hasPermission(actor, "reports.read")) notFound();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const sp = await searchParams;
  const db = await getAppDb();
  const detail = await getCampaign(db, id);
  if (!detail) notFound();
  const { campaign: c, template, review } = detail;
  const locale = await adminLocale();
  const tr = translator(locale);
  const labels = catalogueSection(locale, "email.campaigns");
  const editorLabels = catalogueSection(locale, "email.editor");
  const localeNames = { "nl-BE": tr("email.editor.locale_nl"), "fr-BE": tr("email.editor.locale_fr"), en: tr("email.editor.locale_en") };
  const canSend = hasPermission(actor, "campaigns.send");
  const editable = canWrite && c.status === "draft";
  const dateFmt = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", dateStyle: "full", timeStyle: "short" });
  const ok = (k: string) => review.checks.find((x) => x.key === k)?.ok ?? false;

  const steps: { key: CampaignStep; done?: boolean }[] = [
    { key: "content", done: ok("content") && ok("locales") },
    { key: "audience", done: ok("segment") },
    { key: "review", done: review.checks.every((x) => x.ok) },
    { key: "schedule", done: c.status !== "draft" },
    ...(c.status !== "draft" ? [{ key: "progress" as const }] : []),
  ];
  const requested = (CAMPAIGN_STEPS as readonly string[]).includes(sp.step ?? "") ? (sp.step as CampaignStep) : null;
  const step: CampaignStep = requested && steps.some((s) => s.key === requested) ? requested : c.status === "draft" ? "content" : "progress";

  const templateDetail = step === "content" && editable ? await getTemplate(db, template.id) : null;
  const segments = step === "audience" ? await getSegmentSummaries(db) : [];
  const defaultTo = step === "review" ? await staffEmailOf(db, actor.userId) : "";
  const count = (s: string) => detail.counts[s] ?? 0;
  const skipped = Object.entries(detail.counts)
    .filter(([s]) => s.startsWith("skipped_"))
    .reduce((n, [, v]) => n + v, 0);

  return (
    <div className="grid gap-6" data-campaign-status={c.status}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{c.name}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant={c.status === "sent" ? "default" : "secondary"} data-testid="campaign-status">
              {clab(labels, `status_${c.status}`)}
            </Badge>
            <Badge variant="outline">{clab(labels, `purpose_${c.purpose}`)}</Badge>
            {detail.segment ? <span>{detail.segment.name}</span> : null}
            {c.scheduledAt && c.status !== "draft" ? <span>{clab(labels, "scheduled_for", { at: dateFmt.format(c.scheduledAt) })}</span> : null}
          </div>
        </div>
        <CampaignControls
          campaignId={c.id}
          name={c.name}
          status={c.status}
          pausedReason={c.pausedReason}
          version={c.version}
          canSend={canSend}
          canWrite={canWrite}
          labels={labels}
        />
      </div>
      {!canWrite ? <p className="text-sm text-muted-foreground">{clab(labels, "read_only")}</p> : null}
      {c.lastError && c.status === "draft" ? (
        <Alert variant="destructive">
          <AlertDescription>{clab(labels, "last_error", { error: c.lastError })}</AlertDescription>
        </Alert>
      ) : null}
      <CampaignStepper campaignId={c.id} current={step} steps={steps} labels={labels} />

      {step === "content" ? (
        templateDetail?.editing ? (
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">{clab(labels, "content_intro")}</p>
            <BlockEditor
              templateId={template.id}
              canPublish={false}
              canReadPersons={hasPermission(actor, "persons.read")}
              localeNames={localeNames}
              defaultTo={await staffEmailOf(db, actor.userId)}
              labels={editorLabels}
              mergeFields={templateDetail.mergeFields}
              initial={{
                subject: templateDetail.editing.subject,
                preheader: templateDetail.editing.preheader,
                document: templateDetail.editing.document ?? emptyDocument(),
                draftUpdatedAt: (templateDetail.draftUpdatedAt ?? templateDetail.editing.updatedAt).toISOString(),
                completeness: templateDetail.completeness,
                hasDraft: !!templateDetail.draft,
                hasCurrent: !!templateDetail.current,
              }}
            />
          </div>
        ) : (
          <div className="grid gap-2 text-sm">
            <p className="text-muted-foreground">{clab(labels, "content_locked")}</p>
            <div>
              <Button variant="outline" asChild>
                <Link href={`/admin/templates/${template.id}`}>{clab(labels, "open_template")}</Link>
              </Button>
            </div>
          </div>
        )
      ) : null}

      {step === "audience" ? (
        <AudiencePicker
          campaignId={c.id}
          version={c.version}
          purpose={c.purpose}
          segments={segments.map((s) => ({ id: s.id, name: s.name, lastCount: s.lastCount }))}
          segmentId={c.segmentId}
          excludeSegmentIds={c.excludeSegmentIds}
          editable={editable}
          localeNames={localeNames}
          labels={labels}
        />
      ) : null}

      {step === "review" ? (
        <div className="grid gap-6">
          <ReviewChecklist campaignId={c.id} review={review} localeNames={localeNames} labels={labels} />
          <div className="flex flex-wrap gap-2" id="test-send">
            {canWrite ? (
              <TestSendDialog
                templateId={template.id}
                campaignId={c.id}
                defaultTo={defaultTo}
                hasDraft={!!detail.draft}
                hasCurrent={!!detail.current}
                canReadPersons={hasPermission(actor, "persons.read")}
                localeNames={localeNames}
                sendTestEmail={sendTestEmail}
                labels={editorLabels}
                disabled={c.status !== "draft"}
              />
            ) : null}
            <Button variant="outline" asChild>
              <Link href={`/admin/templates/${template.id}/preview`}>{clab(labels, "open_preview")}</Link>
            </Button>
          </div>
        </div>
      ) : null}

      {step === "schedule" ? (
        c.status === "draft" ? (
          <SchedulePanel
            campaignId={c.id}
            version={c.version}
            initialLocal={suggestedStart(c.scheduledAt)}
            canSchedule={canSend}
            labels={labels}
          />
        ) : (
          <p className="text-sm">{c.scheduledAt ? clab(labels, "scheduled_for", { at: dateFmt.format(c.scheduledAt) }) : null}</p>
        )
      ) : null}

      {step === "progress" ? (
        <section className="grid gap-4" data-testid="campaign-progress">
          <h2 className="text-lg font-semibold">{clab(labels, "progress_title")}</h2>
          {c.status === "planning" ? <p className="text-sm text-muted-foreground">{clab(labels, "planning_note")}</p> : null}
          {c.status === "paused" && c.pausedReason ? (
            <Alert variant={c.pausedReason === "bounce_rate" ? "destructive" : "default"}>
              <AlertDescription>{clab(labels, `paused_${c.pausedReason}`)}</AlertDescription>
            </Alert>
          ) : null}
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["count_recipients", c.recipientsCount],
              ["count_sent", count("sent")],
              [c.status === "stopped" ? "count_not_sent_stopped" : "count_planned", count("planned")],
              ["count_removed", count("removed")],
              ["count_skipped", skipped],
              ["count_failed", count("failed")],
            ].map(([k, v]) => (
              <div key={k} className="rounded-md border p-3" data-count={k}>
                <dt className="text-xs text-muted-foreground">{clab(labels, String(k))}</dt>
                <dd className="text-xl font-semibold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
            {c.startedAt ? <span>{clab(labels, "started_at", { at: dateFmt.format(c.startedAt) })}</span> : null}
            {c.finishedAt ? <span>{clab(labels, "finished_at", { at: dateFmt.format(c.finishedAt) })}</span> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link href={`/admin/campaigns/${c.id}/recipients`} data-testid="campaign-recipients-link">
                {clab(labels, "recipients_link")}
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href={`/admin/campaigns/${c.id}/report`} data-testid="campaign-report-link">
                {clab(labels, "report_link")}
              </Link>
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
