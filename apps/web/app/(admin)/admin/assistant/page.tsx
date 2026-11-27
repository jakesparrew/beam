import Link from "next/link";
import type { Route } from "next";
import { formatDateTime } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getOverview } from "@/modules/assistant/queries";
import { SURFACE, usd } from "@/modules/assistant/ui/admin/parts";
import { StatusPill } from "@/modules/platform/ui/admin-kit";
import { KpiStrip, Notice } from "@/modules/platform/ui/admin-list-kit";
import { AssistantHeader } from "./assistant-header";

export const dynamic = "force-dynamic";

/**
 * `/admin/assistant` (`assistant.read`): what the guide, the coach and the analyst did this week,
 * what it brought in (leads, qualified leads, bookings after a conversation), what it cost against
 * the caps, the questions it could not answer and the agent log.
 */
export default async function AssistantOverviewPage() {
  const actor = await requireStaff({ permission: "assistant.read" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const o = await getOverview(db);
  const pct = (v: number | null) => (v == null ? "–" : `${Math.round(v * 100)}%`);
  const bar = (value: number, cap: number) => (
    <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
      <div className={`h-full rounded-full ${value >= cap ? "bg-[#b42318]" : "bg-[linear-gradient(90deg,#b57627,#f7cc78)]"}`} style={{ width: `${Math.min(100, cap ? (value / cap) * 100 : 0)}%` }} />
    </div>
  );

  return (
    <div className="grid gap-4" data-testid="assistant-overview">
      <AssistantHeader
        active="overview"
        canManage={hasPermission(actor, "assistant.manage")}
        tr={tr}
        aside={<StatusPill tone={o.enabled ? "ok" : "muted"}>{tr(o.enabled ? "assistant.admin.overview.on" : "assistant.admin.overview.off")}</StatusPill>}
      />

      <KpiStrip
        items={[
          { key: "week", label: tr("assistant.admin.kpi.week"), value: o.week, sub: `${tr("assistant.admin.kpi.today")}: ${o.today} · ${tr("assistant.admin.kpi.coach")}: ${o.coachWeek}` },
          { key: "answered", label: tr("assistant.admin.kpi.answered"), value: pct(o.answeredShare), sub: `${tr("assistant.admin.kpi.handoffs")}: ${o.openHandoffs}` },
          { key: "leads", label: tr("assistant.admin.kpi.leads"), value: o.leadsWeek, sub: `${tr("assistant.admin.kpi.qualified")}: ${o.qualifiedWeek}` },
          { key: "bookings", label: tr("assistant.admin.kpi.bookings"), value: o.bookingsAfterChat, sub: `${tr("assistant.admin.kpi.avgCost")}: ${usd(o.avgCostCents)}` },
        ]}
      />

      {o.openHandoffs > 0 ? (
        <Notice tone="bad" action={{ href: "/admin/assistant/conversations?filter=handoff" as Route, label: tr("assistant.nav.conversations") }}>
          <strong className="tabular-nums">{o.openHandoffs}</strong> · {tr("assistant.admin.kpi.handoffs")}
        </Notice>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <section className={`${SURFACE} grid content-start gap-4 p-5`} aria-labelledby="spend-h">
          <h2 id="spend-h">
            {tr("assistant.admin.spend.title")}
          </h2>
          <div className="grid gap-1.5">
            <div className="flex justify-between text-sm">
              <span>{tr("assistant.admin.spend.today")}</span>
              <span className="tabular-nums">
                {usd(o.spend.todayCents)} <span className="text-muted-foreground">{tr("assistant.admin.spend.of", { cap: usd(o.spend.dailyCap) })}</span>
              </span>
            </div>
            {bar(o.spend.todayCents, o.spend.dailyCap)}
          </div>
          <div className="grid gap-1.5">
            <div className="flex justify-between text-sm">
              <span>{tr("assistant.admin.spend.month")}</span>
              <span className="tabular-nums">
                {usd(o.spend.monthCents)} <span className="text-muted-foreground">{tr("assistant.admin.spend.of", { cap: usd(o.spend.monthlyCap) })}</span>
              </span>
            </div>
            {bar(o.spend.monthCents, o.spend.monthlyCap)}
          </div>
          <p className="text-xs text-muted-foreground">{tr("assistant.admin.spend.note")}</p>
          <div className="grid gap-1.5 border-t pt-3">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{tr("assistant.admin.models.title")}</p>
            {(["guide", "coach", "analyst"] as const).map((r) => (
              <p key={r} className="flex justify-between gap-3 text-sm">
                <span>{tr(`assistant.admin.role.${r}`)}</span>
                <code className="truncate text-xs text-muted-foreground">{o.models[r]}</code>
              </p>
            ))}
          </div>
        </section>

        <section className={`${SURFACE} grid content-start gap-3 p-5 lg:col-span-2`} aria-labelledby="unanswered-h">
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="unanswered-h">
              {tr("assistant.admin.unanswered.title")}
            </h2>
            <Link href={"/admin/inbox/knowledge" as Route} className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
              {tr("assistant.admin.unanswered.write")}
            </Link>
          </div>
          {o.unanswered.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tr("assistant.admin.unanswered.empty")}</p>
          ) : (
            <ul className="divide-y">
              {o.unanswered.map((u, i) => (
                <li key={i} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="text-sm">“{u.question}”</span>
                  <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                    {formatDateTime(u.at, locale)}
                    {u.conversationId ? (
                      <Link href={`/admin/assistant/conversations/${u.conversationId}` as Route} className="rounded-full border px-2.5 py-1 hover:bg-accent">
                        →
                      </Link>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className={`${SURFACE} grid gap-3 p-5`} aria-labelledby="log-h">
        <h2 id="log-h">
          {tr("assistant.admin.log.title")}
        </h2>
        {o.actions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tr("assistant.admin.log.empty")}</p>
        ) : (
          <ol className="grid gap-0.5">
            {o.actions.map((a) => (
              <li key={a.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-xl px-2 py-2 hover:bg-muted/60">
                <span className="size-2 rounded-full bg-[#d1a64a]" aria-hidden="true" />
                <span className="min-w-0 truncate text-sm">
                  <strong className="font-semibold">{tr(`assistant.admin.action.${a.kind}`)}</strong>
                  <span className="text-muted-foreground">
                    {" · "}
                    {a.personId ? (
                      <Link href={`/admin/persons/${a.personId}` as Route} className="underline-offset-2 hover:underline">
                        {a.personName ?? a.personId.slice(0, 8)}
                      </Link>
                    ) : (
                      tr("assistant.admin.log.anonymous")
                    )}
                    {describe(a.kind, a.detail)}
                  </span>
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {formatDateTime(a.at, locale)}
                  {a.conversationId ? (
                    <Link href={`/admin/assistant/conversations/${a.conversationId}` as Route} className="rounded-full border px-2 py-0.5 hover:bg-accent">
                      →
                    </Link>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

/** A few words of detail per log kind (tags, score, question). */
function describe(kind: string, d: Record<string, unknown>): string {
  if (kind === "tags_applied" && Array.isArray(d.tags)) return ` · ${(d.tags as string[]).join(", ")}`;
  if ((kind === "analysed" || kind === "lead_qualified") && typeof d.score === "number") return ` · score ${d.score}`;
  if (kind === "unanswered" && typeof d.question === "string") return ` · “${d.question}”`;
  if (kind === "handoff_opened" && typeof d.reason === "string") return ` · ${d.reason}`;
  if (kind === "consent_recorded" && typeof d.purpose === "string") return ` · ${d.purpose}`;
  return "";
}
