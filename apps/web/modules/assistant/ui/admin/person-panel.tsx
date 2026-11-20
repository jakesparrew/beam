/**
 * The "AI assistant" panel on the staff person page: the best lead score, and per conversation the
 * analyst's summary, interests, the CRM tags it applied and the person's own words behind them.
 */
import Link from "next/link";
import type { Route } from "next";
import type { PersonAssistantPanel } from "../../api";
import { ScorePill, SURFACE } from "./parts";

type Tr = (key: string, params?: Record<string, string | number>) => string;

export function AssistantPersonPanel({ panel, tr, formatDate }: { panel: PersonAssistantPanel; tr: Tr; formatDate: (d: Date) => string }) {
  if (!panel.conversations.length) return null;
  return (
    <section className={`${SURFACE} grid gap-4 p-5 sm:p-6`} aria-labelledby="assistant-panel-h" data-testid="panel-assistant">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="assistant-panel-h" className="text-lg font-semibold">
          {tr("assistant.admin.panel.title")}
        </h2>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {tr("assistant.admin.panel.best")} <ScorePill score={panel.bestScore} />
        </span>
      </div>
      <ul className="grid gap-3">
        {panel.conversations.slice(0, 4).map((c) => (
          <li key={c.id} className="grid gap-2 rounded-2xl border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {tr(`assistant.admin.role.${c.role}`)} · {formatDate(c.lastMessageAt)} · {tr("assistant.admin.conversations.messages", { count: c.messageCount })}
              </span>
              <span className="flex items-center gap-2">
                <ScorePill score={c.score} />
                <Link href={`/admin/assistant/conversations/${c.id}` as Route} className="rounded-full border px-2.5 py-1 hover:bg-accent">
                  {tr("assistant.admin.panel.open")} →
                </Link>
              </span>
            </div>
            {c.summary ? <p className="text-sm">{c.summary}</p> : null}
            {c.tags.length ? (
              <div className="flex flex-wrap gap-1.5">
                {c.tags.map((t) => (
                  <span key={t} className="rounded-full bg-[#f6efdf] px-2 py-0.5 text-xs text-[#7a4a12]">
                    {t}
                  </span>
                ))}
              </div>
            ) : null}
            {Object.keys(c.quotes).length ? (
              <div className="grid gap-1">
                {Object.entries(c.quotes)
                  .slice(0, 3)
                  .map(([k, q]) => (
                    <p key={k} className="border-l-2 border-[#d1a64a] pl-2 text-xs text-muted-foreground">
                      {k}: “{q}”
                    </p>
                  ))}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
