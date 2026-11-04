import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cn } from "@beam/ui";
import { ACTION_CARD_KEYS, type ActionCardKey } from "@beam/core/ops";
import { formatDate, formatMoney, type Locale } from "@beam/core/i18n";
import { translator } from "@/lib/i18n";
import { getActionDashboard, type ActionCard as ActionCardData, type ActionCardRow } from "@/modules/ops/dashboard/queries";
import { DASHBOARD_PERMISSIONS } from "@/modules/ops/dashboard/cards";
import { staffReadCtx } from "@/modules/ops/reports/queries";
import { holdsAny } from "@/modules/ops/reports/registry";
import { ActionCard, type ActionCardRowView } from "@/modules/ops/ui/ActionCard";

/**
 * `/admin/dashboard` (ops spec 5, rules 22a-33): one card per list with its count, the first
 * rows and "Create task" per row. `?view=week` widens the date horizons (rule 22b); `?card=<key>`
 * opens one card's list (50 rows). `reports.read` or `tasks.all`; cards are filtered by their
 * own permission.
 */
export const dynamic = "force-dynamic";

const DAY = 86_400_000;
const DATED_FLAG_CARDS: ReadonlySet<ActionCardKey> = new Set(["memberships_expiring", "unused_packages_expiring", "overdue_privacy_requests"]);

function rowText(card: ActionCardKey, row: ActionCardRow, locale: Locale, tr: (key: string, params?: Record<string, string | number>) => string): string {
  const p = row.params;
  const date = typeof p.date === "string" ? formatDate(p.date.length === 10 ? p.date : new Date(p.date), locale) : "-";
  const params: Record<string, string | number> = {
    date,
    amount: typeof p.amount === "number" ? formatMoney(p.amount, locale) : "-",
    remaining: p.remaining ?? "-",
    total: p.total ?? "-",
    days: p.days ?? "-",
    kind: typeof p.kind === "string" ? tr(`ops.privacy.kind.${p.kind}`) : "-",
    company: p.company ?? "-",
    stage: p.stage ?? "-",
    guests: p.guests ?? "-",
  };
  return tr(`ops.dashboard.card.${card}.row`, params);
}

function rowFlag(card: ActionCardKey, row: ActionCardRow, now: Date, label: string): string | undefined {
  if (!DATED_FLAG_CARDS.has(card) || typeof row.params.date !== "string") return undefined;
  const at = new Date(row.params.date.length === 10 ? `${row.params.date}T12:00:00Z` : row.params.date);
  return at.getTime() - now.getTime() < 5 * DAY ? label : undefined;
}

function rowHref(card: ActionCardKey, row: ActionCardRow): Route | null {
  if (card === "overdue_tasks") return "/admin/tasks";
  return row.personId ? (`/admin/persons/${row.personId}` as Route) : null;
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ view?: string; card?: string }> }) {
  const ctx = await staffReadCtx();
  if (!holdsAny(ctx.actor, ...DASHBOARD_PERMISSIONS)) notFound();
  const sp = await searchParams;
  const view = sp.view === "week" ? "week" : "today";
  const expand = (ACTION_CARD_KEYS as readonly string[]).includes(sp.card ?? "") ? (sp.card as ActionCardKey) : undefined;
  const tr = translator(ctx.locale);
  const cards = await getActionDashboard(ctx, { view, expand });
  const shown: ActionCardData[] = expand ? cards.filter((c) => c.key === expand) : cards;
  const errors = Object.fromEntries(["unauthorized", "forbidden", "validation", "not_found", "conflict", "rate_limited"].map((c) => [c, tr(`platform.errors.${c}`)]));

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{tr(view === "week" ? "ops.dashboard.view.week" : "ops.dashboard.title")}</h1>
        <nav aria-label={tr("ops.nav.dashboard")} className="flex gap-2" data-testid="dashboard-view">
          {(["today", "week"] as const).map((v) => (
            <Link
              key={v}
              href={{ pathname: "/admin/dashboard", query: v === "week" ? { view: v } : {} }}
              aria-current={v === view ? "page" : undefined}
              className={cn(
                "rounded-md border px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                v === view ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted",
              )}
            >
              {tr(`ops.dashboard.view.${v}`)}
            </Link>
          ))}
        </nav>
      </div>
      {expand ? (
        <Link href={{ pathname: "/admin/dashboard", query: view === "week" ? { view } : {} }} className="text-sm underline-offset-4 hover:underline">
          {tr("ops.nav.dashboard")}
        </Link>
      ) : null}
      <div className={cn("grid gap-4", expand ? "" : "md:grid-cols-2 xl:grid-cols-3")}>
        {shown.map((card) => {
          const rows: ActionCardRowView[] = card.rows.map((row) => ({
            personId: row.personId,
            refId: row.refId,
            name: row.name ?? "-",
            text: rowText(card.key, row, ctx.locale, tr),
            flag: rowFlag(card.key, row, ctx.now, tr("ops.privacy.due_soon")),
            href: rowHref(card.key, row),
          }));
          return (
            <ActionCard
              key={card.key}
              cardKey={card.key}
              count={card.count}
              rows={rows}
              canCreateTask={card.canCreateTask}
              listHref={
                card.key === "overdue_tasks"
                  ? "/admin/tasks"
                  : expand
                    ? null
                    : { pathname: "/admin/dashboard", query: view === "week" ? { view, card: card.key } : { card: card.key } }
              }
              labels={{
                title: tr(`ops.dashboard.card.${card.key}.title`),
                count: tr("ops.dashboard.count", { count: card.count }),
                empty: tr(`ops.dashboard.card.${card.key}.empty`),
                createTask: tr("ops.dashboard.create_task"),
                taskCreated: tr("ops.dashboard.task_created"),
                taskExists: tr("ops.dashboard.task_exists"),
                openList: tr("ops.dashboard.open_list"),
                openPerson: tr("ops.common.open_person"),
                error: tr("platform.errors.internal", { requestId: "-" }),
                errors,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
