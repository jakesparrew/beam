import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { formatDateTime } from "@beam/core/i18n";
import type { AssistantCard } from "@beam/db/schema";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getConversation } from "@/modules/assistant/queries";
import { ScorePill, SURFACE, usd } from "@/modules/assistant/ui/admin/parts";
import { ReplyBox } from "@/modules/assistant/ui/admin/reply-box";

export const dynamic = "force-dynamic";

const cardText = (c: AssistantCard) => (c.type === "sessions" ? `${c.sessions.length} sessies` : c.type === "link" ? `knop “${c.label}”` : c.type === "contact" ? "contactformulier" : "collega gevraagd");

/**
 * `/admin/assistant/conversations/[id]` (`assistant.read`): the transcript with, under every
 * answer, the model, tokens, cache use, cost and each tool call with its input and result; the
 * analyst's reading with the quotes behind it and the lead score; the agent log of this
 * conversation; and the reply box (the first reply takes the conversation over).
 */
export default async function AssistantConversationPage({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff({ permission: "assistant.read" });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const data = await getConversation(await getAppDb(), id);
  if (!data) notFound();
  const { conversation: c, person, messages, actions } = data;
  const a = c.analysis;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href={"/admin/assistant/conversations" as Route} className="text-sm text-muted-foreground hover:text-foreground">
            ← {tr("assistant.admin.detail.back")}
          </Link>
          <h1 className="font-display mt-1 text-3xl">{person?.name ?? tr("assistant.admin.conversations.anonymous")}</h1>
          <p className="text-sm text-muted-foreground">
            {tr(`assistant.admin.role.${c.role}`)} · {tr(`assistant.admin.status.${c.status}`)} · {tr("assistant.admin.detail.page")}: {c.page ?? "–"} · {formatDateTime(c.createdAt, locale)} · {tr("assistant.admin.detail.cost")} {usd(Number(c.costCents))}
          </p>
        </div>
        {person ? (
          <Link href={`/admin/persons/${person.id}` as Route} className="rounded-full border px-4 py-2 text-sm hover:bg-accent">
            {tr("assistant.admin.detail.person")} →
          </Link>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className={`${SURFACE} grid content-start gap-4 p-5`} aria-labelledby="transcript-h">
          <h2 id="transcript-h" className="text-lg font-semibold">
            {tr("assistant.admin.detail.transcript")}
          </h2>
          <ol className="grid gap-4">
            {messages.map((m) => (
              <li key={m.id} className={m.author === "visitor" ? "justify-self-end" : ""}>
                <div className={`max-w-[42rem] rounded-2xl px-4 py-3 text-sm leading-relaxed ${m.author === "visitor" ? "bg-[#212842] text-[#fffaef]" : m.author === "staff" ? "bg-[#f6efdf]" : "bg-muted/60"}`}>
                  <p className={`mb-1 text-[11px] font-semibold tracking-wide uppercase ${m.author === "visitor" ? "text-[#fffaef]/60" : "text-muted-foreground"}`}>
                    {m.author === "staff" ? `${tr("assistant.admin.detail.staff")} · ${m.staffName ?? ""}` : tr(`assistant.admin.detail.${m.author}`)} · {formatDateTime(m.createdAt, locale)}
                    {m.rating ? ` · ${m.rating > 0 ? "👍" : "👎"}` : ""}
                  </p>
                  <p className="whitespace-pre-wrap">{m.body}</p>
                  {m.cards.length ? <p className="mt-2 text-xs text-muted-foreground">{tr("assistant.admin.detail.cards", { cards: m.cards.map(cardText).join(", ") })}</p> : null}
                </div>
                {m.author === "assistant" && m.model ? (
                  <details className="mt-1.5 max-w-[42rem] rounded-xl border px-3 py-2 text-xs text-muted-foreground">
                    <summary className="cursor-pointer select-none">
                      <code>{m.model}</code> · {usd(Number(m.costCents))} · {tr("assistant.admin.detail.usage", { input: m.inputTokens, output: m.outputTokens, cached: m.cacheReadTokens, ms: m.durationMs ?? 0 })}
                      {m.tools.length ? ` · ${tr("assistant.admin.detail.trace")}: ${m.tools.map((t) => t.name).join(", ")}` : ""}
                    </summary>
                    {m.tools.length ? (
                      <ol className="mt-2 grid gap-2">
                        {m.tools.map((t, i) => (
                          <li key={i} className="grid gap-1 rounded-lg bg-muted/50 p-2">
                            <p className="font-semibold text-foreground">
                              {t.name} <span className="font-normal text-muted-foreground">· {t.ms} ms</span>
                            </p>
                            <pre className="overflow-x-auto text-[11px] whitespace-pre-wrap">in: {JSON.stringify(t.input)}</pre>
                            <pre className="max-h-40 overflow-auto text-[11px] whitespace-pre-wrap">uit: {JSON.stringify(t.output, null, 1).slice(0, 2000)}</pre>
                          </li>
                        ))}
                      </ol>
                    ) : null}
                  </details>
                ) : null}
              </li>
            ))}
          </ol>
          {data.takenOverBy ? <p className="rounded-xl bg-[#e7f1ea] px-3 py-2 text-sm text-[#2f6d44]">{tr("assistant.admin.detail.takenOver", { name: data.takenOverBy })}</p> : null}
          <div className="border-t pt-4">
            <ReplyBox
              conversationId={c.id}
              takenOver={!!c.takenOverByUserId}
              closed={c.status === "closed"}
              labels={{ reply: tr("assistant.admin.detail.reply"), hint: tr("assistant.admin.detail.replyHint"), send: tr("assistant.admin.detail.send"), release: tr("assistant.admin.detail.release"), close: tr("assistant.admin.detail.close") }}
            />
          </div>
        </section>

        <aside className="grid content-start gap-4">
          <section className={`${SURFACE} grid gap-3 p-5`} aria-labelledby="analysis-h">
            <div className="flex items-center justify-between">
              <h2 id="analysis-h" className="text-lg font-semibold">
                {tr("assistant.admin.detail.analysis")}
              </h2>
              <ScorePill score={c.score} />
            </div>
            {!a ? (
              <p className="text-sm text-muted-foreground">{tr("assistant.admin.detail.noAnalysis")}</p>
            ) : (
              <dl className="grid gap-2.5 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">{tr("assistant.admin.detail.summary")}</dt>
                  <dd>{a.summary}</dd>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <dt className="text-xs text-muted-foreground">{tr("assistant.admin.detail.intent")}</dt>
                    <dd className="font-semibold">{a.intent}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{tr("assistant.admin.detail.urgency")}</dt>
                    <dd className="font-semibold">{a.urgency ?? "–"}</dd>
                  </div>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{tr("assistant.admin.detail.interests")}</dt>
                  <dd>{a.interests.length ? a.interests.join(", ") : "–"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{tr("assistant.admin.detail.objections")}</dt>
                  <dd>{a.objections.length ? a.objections.join(", ") : "–"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{tr("assistant.admin.detail.tags")}</dt>
                  <dd className="flex flex-wrap gap-1.5 pt-0.5">
                    {a.tags.length ? a.tags.map((t) => <span key={t} className="rounded-full bg-[#f6efdf] px-2 py-0.5 text-xs text-[#7a4a12]">{t}</span>) : "–"}
                  </dd>
                </div>
                {c.scoreReason ? (
                  <div>
                    <dt className="text-xs text-muted-foreground">{tr("assistant.admin.detail.score")}</dt>
                    <dd className="text-xs">{c.scoreReason}</dd>
                  </div>
                ) : null}
                {Object.keys(a.quotes).length ? (
                  <div>
                    <dt className="text-xs text-muted-foreground">{tr("assistant.admin.detail.quotes")}</dt>
                    <dd className="grid gap-1 pt-1">
                      {Object.entries(a.quotes).map(([k, q]) => (
                        <p key={k} className="border-l-2 border-[#d1a64a] pl-2 text-xs">
                          <span className="text-muted-foreground">{k}:</span> “{q}”
                        </p>
                      ))}
                    </dd>
                  </div>
                ) : null}
              </dl>
            )}
          </section>

          <section className={`${SURFACE} grid gap-2 p-5`} aria-labelledby="clog-h">
            <h2 id="clog-h" className="text-lg font-semibold">
              {tr("assistant.admin.detail.log")}
            </h2>
            {actions.length === 0 ? (
              <p className="text-sm text-muted-foreground">{tr("assistant.admin.log.empty")}</p>
            ) : (
              <ol className="grid gap-1.5 text-sm">
                {actions.map((x) => (
                  <li key={x.id} className="flex justify-between gap-2">
                    <span>{tr(`assistant.admin.action.${x.kind}`)}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(x.createdAt, locale)}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
