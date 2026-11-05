import type { Route } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Button, cn, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { formatDate, formatDateTime, formatMoney } from "@beam/core/i18n";
import { RETENTION_DISMISS_REASONS, RETENTION_REASONS } from "@beam/core/ops";
import { flag } from "@/lib/flags";
import { translator } from "@/lib/i18n";
import { staffReadCtx } from "@/modules/ops/reports/queries";
import { holdsAny } from "@/modules/ops/reports/registry";
import { createAllRetentionTasks, createRetentionTask, dismissRetentionItem, rebuildRetentionList } from "@/modules/ops/retention/actions";
import { getWeeklyRetentionList, listRetentionCandidates, type RetentionListItem } from "@/modules/ops/retention/queries";

/**
 * `/admin/dashboard/retention` (ops spec 5, rules 19-22; `reports.read`, behind
 * `ff_ops_retention`): this week's list (rank, person, main reason, every reason, score, revenue,
 * last visit, task status) with "Create task", "Create all tasks", "Dismiss" (a reason is
 * required) and "Rebuild" for `tasks.all`, and the tab "All candidates" by reason. The buttons
 * are plain forms posting the module's actions; the page reloads with the outcome.
 */
export const dynamic = "force-dynamic";

const BASE = "/admin/dashboard/retention";

const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
};
const back = (query: Record<string, string>) => `${BASE}?${new URLSearchParams(query).toString()}` as Route;

async function onCreateTask(form: FormData) {
  "use server";
  const r = await createRetentionTask({ itemId: field(form, "itemId") });
  redirect(back(r.ok ? { done: "task_created" } : { error: r.error.code }));
}

async function onCreateAll(form: FormData) {
  "use server";
  const r = await createAllRetentionTasks({ listId: field(form, "listId") });
  redirect(back(r.ok ? { done: "tasks_created", count: String(r.data.created) } : { error: r.error.code }));
}

async function onDismiss(form: FormData) {
  "use server";
  const note = field(form, "note").trim();
  const r = await dismissRetentionItem({ itemId: field(form, "itemId"), reason: field(form, "reason"), ...(note ? { note } : {}) });
  redirect(back(r.ok ? { done: "dismissed" } : { error: r.error.code }));
}

async function onRebuild() {
  "use server";
  const r = await rebuildRetentionList({});
  redirect(back(r.ok ? { done: "rebuilt" } : { error: r.error.code }));
}

const DONE = new Set(["task_created", "tasks_created", "dismissed", "rebuilt"]);
const ERRORS = new Set(["unauthorized", "forbidden", "validation", "not_found", "conflict", "rate_limited", "internal"]);

export default async function RetentionPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; reason?: string; page?: string; done?: string; error?: string; count?: string }>;
}) {
  const ctx = await staffReadCtx({ permission: "reports.read" });
  if (!(await flag("ff_ops_retention", ctx.actor))) notFound();
  const sp = await searchParams;
  const tr = translator(ctx.locale);
  const tab = sp.tab === "candidates" ? "candidates" : "list";
  const canTask = holdsAny(ctx.actor, "tasks.all");
  const money = (c: number) => formatMoney(c, ctx.locale);

  const notice = DONE.has(sp.done ?? "") ? tr(`ops.retention.result.${sp.done}`, { count: Number(sp.count ?? 0) }) : null;
  const failure = ERRORS.has(sp.error ?? "") ? tr(`platform.errors.${sp.error}`, { requestId: "-" }) : null;

  return (
    <div className="grid gap-6" data-testid="retention-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{tr("ops.retention.title")}</h1>
        {canTask ? (
          <form action={onRebuild}>
            <Button type="submit" variant="outline" data-testid="retention-rebuild">
              {tr("ops.retention.rebuild")}
            </Button>
          </form>
        ) : null}
      </div>
      {notice ? (
        <p role="status" className="rounded-md border border-success bg-success/10 px-3 py-2 text-sm" data-testid="retention-notice">
          {notice}
        </p>
      ) : null}
      {failure ? (
        <p role="alert" className="rounded-md border border-destructive px-3 py-2 text-sm text-destructive" data-testid="retention-error">
          {failure}
        </p>
      ) : null}

      <nav aria-label={tr("ops.nav.retention")} className="flex gap-2">
        {(["list", "candidates"] as const).map((t) => (
          <Link
            key={t}
            href={{ pathname: BASE, query: t === "candidates" ? { tab: t } : {} }}
            aria-current={t === tab ? "page" : undefined}
            className={cn(
              "rounded-md border px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              t === tab ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted",
            )}
          >
            {tr(`ops.retention.tab.${t}`)}
          </Link>
        ))}
      </nav>

      {tab === "list" ? <WeeklyList ctx={ctx} tr={tr} money={money} canTask={canTask} /> : <Candidates ctx={ctx} tr={tr} reason={sp.reason} page={Number(sp.page ?? 1) || 1} />}
    </div>
  );
}

type Tr = ReturnType<typeof translator>;
type ReadCtx = Awaited<ReturnType<typeof staffReadCtx>>;

function taskCell(item: RetentionListItem, tr: Tr) {
  if (item.dismissedAt) return <Badge variant="secondary">{tr("ops.retention.task_status.dismissed", { reason: tr(`ops.retention.dismiss.${item.dismissReason ?? "other"}`) })}</Badge>;
  if (!item.taskId) return <span className="text-muted-foreground">{tr("ops.retention.task_status.none")}</span>;
  return <Badge variant={item.taskStatus === "done" ? "success" : "outline"}>{tr(`ops.retention.task_status.${item.taskStatus ?? "open"}`)}</Badge>;
}

async function WeeklyList({ ctx, tr, money, canTask }: { ctx: ReadCtx; tr: Tr; money: (c: number) => string; canTask: boolean }) {
  const week = await getWeeklyRetentionList(ctx);
  const open = week.items.filter((i) => !i.taskId && !i.dismissedAt).length;
  return (
    <section className="grid gap-3" data-testid="retention-list">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {tr("ops.retention.week_of", { date: formatDate(week.weekStartOn, ctx.locale, "long") })}
          {week.list ? ` · ${tr("ops.retention.generated_at", { date: formatDateTime(week.list.generatedAt, ctx.locale) })}` : null}
        </p>
        {canTask && week.list && open > 0 ? (
          <form action={onCreateAll}>
            <input type="hidden" name="listId" value={week.list.id} />
            <Button type="submit" data-testid="retention-create-all">
              {tr("ops.retention.create_all")}
            </Button>
          </form>
        ) : null}
      </div>
      {!week.list ? (
        <EmptyState title={tr("ops.retention.empty")} description={tr("ops.retention.not_built")} />
      ) : week.items.length === 0 ? (
        <EmptyState title={tr("ops.retention.empty")} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">{tr("ops.retention.column.rank")}</TableHead>
              <TableHead>{tr("ops.retention.column.person")}</TableHead>
              <TableHead>{tr("ops.retention.column.primary_reason")}</TableHead>
              <TableHead>{tr("ops.retention.column.reasons")}</TableHead>
              <TableHead className="text-right">{tr("ops.retention.column.score")}</TableHead>
              <TableHead className="text-right">{tr("ops.retention.column.revenue")}</TableHead>
              <TableHead>{tr("ops.retention.column.last_visit")}</TableHead>
              <TableHead>{tr("ops.retention.column.task")}</TableHead>
              {canTask ? <TableHead>{tr("ops.retention.column.actions")}</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {week.items.map((item) => (
              <TableRow key={item.id} data-testid="retention-item" data-person-id={item.personId}>
                <TableCell className="tabular-nums">{item.rank}</TableCell>
                <TableCell>
                  <Link href={`/admin/persons/${item.personId}` as Route} className="font-medium underline-offset-4 hover:underline">
                    {item.name ?? "-"}
                  </Link>
                </TableCell>
                <TableCell>{tr(`ops.retention.reason.${item.primaryReason}`)}</TableCell>
                <TableCell>
                  <ul className="flex flex-wrap gap-1">
                    {item.reasons.map((r) => (
                      <li key={r}>
                        <Badge variant="outline">{tr(`ops.retention.reason.${r}`)}</Badge>
                      </li>
                    ))}
                  </ul>
                </TableCell>
                <TableCell className="text-right tabular-nums">{item.score}</TableCell>
                <TableCell className="text-right tabular-nums">{money(item.revenueCents)}</TableCell>
                <TableCell>{item.lastVisitAt ? formatDate(item.lastVisitAt, ctx.locale) : "-"}</TableCell>
                <TableCell>{taskCell(item, tr)}</TableCell>
                {canTask ? (
                  <TableCell>
                    {item.taskId ? (
                      <Link href={`/admin/persons/${item.personId}` as Route} className="text-sm underline-offset-4 hover:underline" data-testid="retention-open-task">
                        {tr("ops.retention.open_task")}
                      </Link>
                    ) : item.dismissedAt ? null : (
                      <div className="flex flex-wrap items-start gap-2">
                        <form action={onCreateTask}>
                          <input type="hidden" name="itemId" value={item.id} />
                          <Button type="submit" size="sm" data-testid="retention-create-task">
                            {tr("ops.dashboard.create_task")}
                          </Button>
                        </form>
                        <details>
                          <summary className="cursor-pointer text-sm">{tr("ops.retention.dismiss_action")}</summary>
                          <form action={onDismiss} className="mt-2 grid gap-2">
                            <input type="hidden" name="itemId" value={item.id} />
                            <label className="grid gap-1 text-sm">
                              {tr("ops.retention.dismiss_reason")}
                              <select name="reason" required defaultValue="" className="rounded-md border bg-background px-2 py-1">
                                <option value="" disabled>
                                  -
                                </option>
                                {RETENTION_DISMISS_REASONS.map((r) => (
                                  <option key={r} value={r}>
                                    {tr(`ops.retention.dismiss.${r}`)}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="grid gap-1 text-sm">
                              {tr("ops.retention.dismiss_note")}
                              <input name="note" maxLength={500} className="rounded-md border bg-background px-2 py-1" />
                            </label>
                            <Button type="submit" size="sm" variant="outline">
                              {tr("ops.retention.dismiss_action")}
                            </Button>
                          </form>
                        </details>
                      </div>
                    )}
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

async function Candidates({ ctx, tr, reason, page }: { ctx: ReadCtx; tr: Tr; reason?: string; page: number }) {
  const valid = RETENTION_REASONS.find((r) => r === reason);
  const result = await listRetentionCandidates(ctx, { ...(valid ? { reason: valid } : {}), page });
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const query = (p: number) => ({ tab: "candidates", ...(valid ? { reason: valid } : {}), ...(p > 1 ? { page: String(p) } : {}) });
  return (
    <section className="grid gap-3" data-testid="retention-candidates">
      <form method="get" action={BASE} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="tab" value="candidates" />
        <label className="grid gap-1 text-sm">
          {tr("ops.retention.filter.reason")}
          <select name="reason" defaultValue={valid ?? ""} className="rounded-md border bg-background px-2 py-1">
            <option value="">{tr("ops.retention.filter.all")}</option>
            {RETENTION_REASONS.map((r) => (
              <option key={r} value={r}>
                {tr(`ops.retention.reason.${r}`)}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="outline" size="sm">
          {tr("ops.common.apply")}
        </Button>
      </form>
      {result.rows.length === 0 ? (
        <EmptyState title={tr("ops.retention.candidates_empty")} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tr("ops.retention.column.person")}</TableHead>
              <TableHead>{tr("ops.retention.column.primary_reason")}</TableHead>
              <TableHead className="text-right">{tr("ops.retention.column.score")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.map((r) => (
              <TableRow key={`${r.personId}:${r.reason}:${r.refId}`}>
                <TableCell>
                  <Link href={`/admin/persons/${r.personId}` as Route} className="font-medium underline-offset-4 hover:underline">
                    {r.name ?? "-"}
                  </Link>
                </TableCell>
                <TableCell>{tr(`ops.retention.reason.${r.reason}`)}</TableCell>
                <TableCell className="text-right tabular-nums">{r.score}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {pages > 1 ? (
        <nav className="flex items-center gap-3 text-sm" aria-label={tr("ops.common.page", { page })}>
          {page > 1 ? <Link href={{ pathname: BASE, query: query(page - 1) }}>{tr("ops.common.previous_page")}</Link> : null}
          <span>{tr("ops.common.page", { page })}</span>
          {page < pages ? <Link href={{ pathname: BASE, query: query(page + 1) }}>{tr("ops.common.next_page")}</Link> : null}
        </nav>
      ) : null}
    </section>
  );
}
