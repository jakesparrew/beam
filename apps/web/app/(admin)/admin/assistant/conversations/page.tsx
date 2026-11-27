import Link from "next/link";
import type { Route } from "next";
import { formatDateTime } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { CONVERSATION_FILTERS, listConversations, type ConversationFilter } from "@/modules/assistant/queries";
import { ScorePill, SURFACE, usd } from "@/modules/assistant/ui/admin/parts";
import { Segmented } from "@/modules/platform/ui/admin-kit";
import { AssistantHeader } from "../assistant-header";

export const dynamic = "force-dynamic";

/**
 * `/admin/assistant/conversations` (`assistant.read`): every chat, newest first, filtered on
 * "wants a colleague", "didn't know", leads and coach; who, where, how far, the analyst's summary,
 * the lead score and what it cost.
 */
export default async function AssistantConversationsPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const actor = await requireStaff({ permission: "assistant.read" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const filter: ConversationFilter = (CONVERSATION_FILTERS as readonly string[]).includes(sp.filter ?? "") ? (sp.filter as ConversationFilter) : "all";
  const rows = await listConversations(await getAppDb(), filter);

  return (
    <div className="grid gap-4">
      <AssistantHeader active="conversations" canManage={hasPermission(actor, "assistant.manage")} tr={tr} />
      <Segmented
        label={tr("assistant.admin.conversations.title")}
        items={CONVERSATION_FILTERS.map((f) => ({ key: f, label: tr(`assistant.admin.filter.${f}`), href: `/admin/assistant/conversations${f === "all" ? "" : `?filter=${f}`}` as Route, active: f === filter }))}
      />

      {rows.length === 0 ? (
        <p className={`${SURFACE} p-6 text-sm text-muted-foreground`}>{tr("assistant.admin.conversations.empty")}</p>
      ) : (
        <ul className="grid gap-2">
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={`/admin/assistant/conversations/${r.id}` as Route} className={`${SURFACE} grid gap-2 px-5 py-3 hover:bg-[#faf9f6] sm:grid-cols-[1fr_auto]`}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`grid size-8 place-items-center rounded-full text-xs font-semibold ${r.personName ? "bg-[#212842] text-[#fffaef]" : "bg-muted text-muted-foreground"}`} aria-hidden="true">
                      {(r.personName ?? "?").slice(0, 1).toUpperCase()}
                    </span>
                    <span className="font-semibold">{r.personName ?? tr("assistant.admin.conversations.anonymous")}</span>
                    <span className={`rounded-full px-2 py-0.5 text-xs ${r.role === "coach" ? "bg-[#ece9f7] text-[#4b4790]" : "bg-[#f6efdf] text-[#a0621e]"}`}>{tr(`assistant.admin.role.${r.role}`)}</span>
                    {r.status === "handoff" && !r.takenOver ? <span className="rounded-full bg-[#fdecea] px-2 py-0.5 text-xs font-semibold text-[#b42318]">{tr("assistant.admin.status.handoff")}</span> : null}
                    {r.takenOver ? <span className="rounded-full bg-[#e7f1ea] px-2 py-0.5 text-xs text-[#2f6d44]">{tr("assistant.admin.status.takenOver")}</span> : null}
                    {r.unansweredCount > 0 ? <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{tr("assistant.admin.filter.unknown")}</span> : null}
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-sm text-muted-foreground">{r.summary ?? r.lastText ?? ""}</p>
                </div>
                <div className="flex items-center gap-4 text-xs text-muted-foreground sm:flex-col sm:items-end sm:justify-between">
                  <ScorePill score={r.score} />
                  <span>{tr("assistant.admin.conversations.messages", { count: r.messageCount })}</span>
                  <span className="tabular-nums">{usd(r.costCents)}</span>
                  <span>{formatDateTime(r.lastMessageAt, locale)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
