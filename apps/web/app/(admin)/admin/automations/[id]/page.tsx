import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, AlertDescription, AlertTitle, Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@beam/ui";
import type { DpiaKey } from "@beam/core/ops";
import { formatDateTime } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { isDpiaApproved } from "@/modules/ops/api";
import { automationLabels, canViewAutomations, getAutomation, listRuns, listSegmentOptions } from "@/modules/automation/queries";
import { AutomationHeader, describeTrigger, StatTiles, StepList } from "@/modules/automation/ui/automation-table";
import { fill } from "@/modules/automation/ui/outcome-badge";
import { RunLog } from "@/modules/automation/ui/run-log";
import { StatusControls } from "@/modules/automation/ui/status-controls";

const LABEL_PREFIXES = ["detail", "controls", "status", "purpose", "editor", "outcome", "end_reason", "runs", "enrolments", "errors", "common", "list"] as const;

/**
 * `/admin/automations/[id]` (automation spec 5): status with Activate / Pause / Resume / Archive
 * and Enrol segment (`automations.publish`), the trigger in plain words, the published steps with
 * their offsets, stats tiles, the latest 20 runs (`persons.read`), the draft banners and the
 * read-only DPIA and flag gate badges. Activate is disabled with the reason while the DPIA gate
 * is closed (A-5a).
 */
export default async function AutomationPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireStaff();
  if (!canViewAutomations(actor)) notFound();
  const { id } = await params;
  const db = await getAppDb();
  const detail = await getAutomation(db, { id });
  if (!detail) notFound();
  const locale = await adminLocale();
  const l = automationLabels(locale, LABEL_PREFIXES);
  const a = detail.automation;
  const canPublish = hasPermission(actor, "automations.publish");
  const canWrite = hasPermission(actor, "automations.write");
  const canSeePersons = hasPermission(actor, "persons.read");

  let dpia: { key: string; approved: boolean } | null = null;
  if (a.requiresDpia) {
    let approved = false;
    try {
      approved = await isDpiaApproved(db, a.requiresDpia as DpiaKey);
    } catch {
      approved = false;
    }
    dpia = { key: a.requiresDpia, approved };
  }
  const [segments, runs] = await Promise.all([listSegmentOptions(db), canSeePersons ? listRuns(db, { automationId: a.id, limit: 20 }) : Promise.resolve(null)]);
  const segmentNames = Object.fromEntries(segments.map((s) => [s.id, s.name]));
  const published = detail.currentVersion?.definition ?? null;

  return (
    <div className="grid gap-6">
      <AutomationHeader
        id={a.id}
        name={a.name}
        slug={a.slug}
        status={a.status}
        current="overview"
        l={l}
        actions={
          canPublish ? (
            <StatusControls automationId={a.id} slug={a.slug} status={a.status} hasVersion={!!detail.currentVersion} dpia={dpia} segments={segments} labels={l} />
          ) : undefined
        }
      />

      {!detail.currentVersion ? (
        <Alert data-testid="draft-banner">
          <AlertTitle>{l["detail.draft_banner"]}</AlertTitle>
          <AlertDescription>
            {l["detail.draft_banner_body"]}{" "}
            <Link className="underline" href={`/admin/automations/${a.id}/edit`}>
              {l["detail.edit_draft"]}
            </Link>
          </AlertDescription>
        </Alert>
      ) : detail.draftDiffers ? (
        <Alert data-testid="draft-differs">
          <AlertDescription>
            {l["detail.draft_differs"]}{" "}
            <Link className="underline" href={`/admin/automations/${a.id}/edit`}>
              {l["detail.edit_draft"]}
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}

      {dpia || a.requiresFlag ? (
        <div className="flex flex-wrap items-center gap-2" aria-label={l["detail.gates"]}>
          {dpia ? (
            <Badge variant={dpia.approved ? "success" : "warning"} data-testid="dpia-badge">
              {`${fill(l["detail.dpia_badge"], { key: dpia.key })} (${dpia.approved ? l["detail.dpia_approved"] : l["detail.dpia_pending"]})`}
            </Badge>
          ) : null}
          {a.requiresFlag ? (
            <Badge variant="outline" data-testid="flag-badge">
              {fill(l["detail.flag_badge"], { flag: a.requiresFlag })}
            </Badge>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{l["detail.trigger"]}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {published ? (
              <>
                <p data-testid="trigger-summary">{describeTrigger(published, l, segmentNames)}</p>
                <dl className="grid gap-1 text-sm sm:grid-cols-[10rem_1fr]">
                  <dt className="text-muted-foreground">{l["detail.anchor"]}</dt>
                  <dd>{published.anchor === "enrolment" ? l["detail.anchor_enrolment"] : fill(l["detail.anchor_data"], { path: published.anchor })}</dd>
                  <dt className="text-muted-foreground">{l["detail.re_entry"]}</dt>
                  <dd className="font-mono text-xs">{published.re_entry}</dd>
                  <dt className="text-muted-foreground">{l["detail.exit_on"]}</dt>
                  <dd className="font-mono text-xs">{published.exit_on.length ? published.exit_on.map((e) => (typeof e === "string" ? e : e.event)).join(", ") : l["detail.exit_none"]}</dd>
                </dl>
                <h3 className="font-semibold">{l["detail.steps"]}</h3>
                <StepList steps={published.steps} l={l} />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{l["detail.no_steps"]}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="grid gap-2 pt-6 text-sm">
            <dl className="grid grid-cols-[8rem_1fr] gap-1">
              <dt className="text-muted-foreground">{l["detail.group"]}</dt>
              <dd>
                {detail.group.name}
                {detail.group.isExclusive ? (
                  <Badge variant="outline" className="ml-2">
                    {l["list.exclusive"]}
                  </Badge>
                ) : null}
              </dd>
              <dt className="text-muted-foreground">{l["detail.kind"]}</dt>
              <dd>{a.isMarketing ? l["common.marketing"] : l["common.transactional"]}</dd>
              <dt className="text-muted-foreground">{l["detail.purpose"]}</dt>
              <dd>{a.purpose ? l[`purpose.${a.purpose}`] : l["common.none"]}</dd>
              <dt className="text-muted-foreground">{l["detail.priority"]}</dt>
              <dd className="tabular-nums">{a.priority}</dd>
              <dt className="text-muted-foreground">{l["detail.version"]}</dt>
              <dd>
                {detail.currentVersion
                  ? `v${detail.currentVersion.version} · ${fill(l["detail.published_at"], { date: formatDateTime(detail.currentVersion.publishedAt, locale) })}`
                  : l["list.no_version"]}
              </dd>
            </dl>
            {a.description ? <p className="text-muted-foreground">{a.description}</p> : null}
            {canWrite ? (
              <Button variant="outline" asChild className="mt-2 w-fit">
                <Link href={`/admin/automations/${a.id}/edit`}>{l["detail.edit_draft"]}</Link>
              </Button>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <section aria-labelledby="automation-stats-title" className="grid gap-2">
        <h2 id="automation-stats-title" className="text-lg font-semibold">
          {l["detail.stats"]}
        </h2>
        <StatTiles stats={detail.stats} l={l} />
      </section>

      {runs ? (
        <section aria-labelledby="automation-latest-runs" className="grid gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="automation-latest-runs" className="text-lg font-semibold">
              {l["detail.latest_runs"]}
            </h2>
            <Link className="text-sm underline-offset-2 hover:underline" href={`/admin/automations/${a.id}/runs`}>
              {l["detail.all_runs"]}
            </Link>
          </div>
          <RunLog rows={runs.rows} l={l} locale={locale} />
        </section>
      ) : null}
    </div>
  );
}
