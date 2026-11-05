import { notFound, redirect } from "next/navigation";
import type { Route } from "next";
import Link from "next/link";
import { Alert, AlertDescription, Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState } from "@beam/ui";
import { formatDate, formatDateTime } from "@beam/core/i18n";
import { flag } from "@/lib/flags";
import { translator } from "@/lib/i18n";
import { regenerateWeeklySummary } from "@/modules/ops/ai/actions";
import { listWeeklySummaries, type WeeklySummaryView } from "@/modules/ops/ai/queries";
import { holdsAny } from "@/modules/ops/reports/registry";
import { staffReadCtx } from "@/modules/ops/reports/queries";

/**
 * `/admin/dashboard/summary` (ops spec 5, rule 78; `reports.read`, behind `ff_ops_ai`): the
 * weekly management summaries by week, in the user's locale when it was generated (else the
 * English text with the badge "English only"), and "Regenerate" (`ai.use`). Empty state "The
 * first summary arrives Monday 06:30".
 */
export const dynamic = "force-dynamic";

const SUMMARY_PATH = "/admin/dashboard/summary";
const STATUS_VARIANT: Record<WeeklySummaryView["status"], "success" | "secondary" | "destructive" | "warning"> = {
  pending: "secondary",
  ready: "success",
  failed: "destructive",
  skipped_budget: "warning",
};

async function onRegenerate(form: FormData) {
  "use server";
  const raw = form.get("weekStartOn");
  const weekStartOn = typeof raw === "string" ? raw : "";
  const r = await regenerateWeeklySummary({ weekStartOn });
  if (r.ok) redirect(`${SUMMARY_PATH}?week=${weekStartOn}&regenerated=1` as Route);
  redirect(`${SUMMARY_PATH}?week=${encodeURIComponent(weekStartOn)}&error=${r.error.code === "conflict" ? "conflict" : "generic"}` as Route);
}

/** The stored markdown (a bold headline and `- ` points) as paragraphs and a list, never as HTML. */
function SummaryText({ text }: { text: string }) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const points = lines.filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  const paragraphs = lines.filter((l) => !l.startsWith("- ")).map((l) => l.replace(/^\*\*(.*)\*\*$/, "$1"));
  return (
    <div className="grid gap-2 text-sm" data-testid="summary-text">
      {paragraphs.map((p, i) => (
        <p key={i} className={i === 0 ? "font-medium" : undefined}>
          {p}
        </p>
      ))}
      {points.length ? (
        <ul className="list-disc pl-5">
          {points.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default async function WeeklySummaryPage({ searchParams }: { searchParams: Promise<{ week?: string; error?: string; regenerated?: string }> }) {
  const ctx = await staffReadCtx({ permission: "reports.read" });
  if (!(await flag("ff_ops_ai", ctx.actor))) notFound();
  const sp = await searchParams;
  const tr = translator(ctx.locale);
  const weeks = await listWeeklySummaries(ctx);
  const canRegenerate = holdsAny(ctx.actor, "ai.use");
  const selected = sp.week ? weeks.find((w) => w.weekStartOn === sp.week) : undefined;
  const list = selected ? [selected, ...weeks.filter((w) => w !== selected)] : weeks;

  return (
    <div className="grid gap-6" data-testid="ops-summary">
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">{tr("ops.summary.title")}</h1>
        <p className="text-sm text-muted-foreground">{tr("ops.summary.intro")}</p>
      </div>
      {sp.regenerated ? (
        <Alert>
          <AlertDescription>{tr("ops.summary.regenerated")}</AlertDescription>
        </Alert>
      ) : null}
      {sp.error ? (
        <Alert variant="destructive">
          <AlertDescription>{tr(sp.error === "conflict" ? "ops.summary.error.conflict" : "ops.summary.error.generic")}</AlertDescription>
        </Alert>
      ) : null}
      {list.length === 0 ? (
        <EmptyState title={tr("ops.summary.empty")} description={tr("ops.summary.intro")} />
      ) : (
        <ul className="grid gap-4" data-testid="summary-weeks">
          {list.map((w) => (
            <li key={w.weekStartOn}>
              <Card data-testid={`summary-${w.weekStartOn}`} data-status={w.status}>
                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    <Link href={`${SUMMARY_PATH}?week=${w.weekStartOn}` as Route} className="underline-offset-4 hover:underline">
                      {tr("ops.summary.week_of", { date: formatDate(w.weekStartOn, ctx.locale) })}
                    </Link>
                    <Badge variant={STATUS_VARIANT[w.status]}>{tr(`ops.summary.status.${w.status}`)}</Badge>
                    {w.englishOnly ? <Badge variant="outline">{tr("ops.summary.english_only")}</Badge> : null}
                  </CardTitle>
                  {canRegenerate && w.status !== "pending" ? (
                    <form action={onRegenerate}>
                      <input type="hidden" name="weekStartOn" value={w.weekStartOn} />
                      <Button type="submit" variant="outline" size="sm">
                        {tr("ops.summary.regenerate")}
                      </Button>
                    </form>
                  ) : null}
                </CardHeader>
                <CardContent className="grid gap-2">
                  {w.text ? <SummaryText text={w.text} /> : null}
                  {!w.text || w.status !== "ready" ? (
                    <p className="text-sm text-muted-foreground">
                      {w.status === "pending" ? tr("ops.summary.pending_text") : w.status === "failed" ? tr("ops.summary.failed_text") : w.status === "skipped_budget" ? tr("ops.summary.skipped_text") : null}
                    </p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">{tr("ops.summary.updated", { date: formatDateTime(w.updatedAt, ctx.locale) })}</p>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
