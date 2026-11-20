import { formatDateTime } from "@beam/core/i18n";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getSetting } from "@/lib/settings";
import type { AssistantSettingValue } from "@/modules/assistant/config";
import { getEvalSummary } from "@/modules/assistant/queries";
import { AddCase, DeleteCase, RunEval } from "@/modules/assistant/ui/admin/eval-controls";
import { SubNav, SURFACE, assistantSubNav, usd } from "@/modules/assistant/ui/admin/parts";

export const dynamic = "force-dynamic";

/**
 * `/admin/assistant/eval` (`assistant.manage`): the evaluation set (real questions and what a good
 * answer must do), a run on up to four models at once, and per model how many answers passed,
 * the average cost and speed; per question the latest answers side by side with the verdict.
 */
export default async function AssistantEvalPage() {
  await requireStaff({ permission: "assistant.manage" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const [summary, settings] = await Promise.all([getEvalSummary(db), getSetting(db, "assistant") as Promise<AssistantSettingValue>]);

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="font-display text-3xl">{tr("assistant.admin.eval.title")}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{tr("assistant.admin.eval.intro")}</p>
      </div>
      <SubNav active="eval" items={assistantSubNav(tr)} />

      <section className={`${SURFACE} grid gap-4 p-5`}>
        <RunEval models={settings.models.map((m) => ({ id: m.id, label: m.label }))} labels={{ run: tr("assistant.admin.eval.run"), hint: tr("assistant.admin.eval.runHint"), started: tr("assistant.admin.eval.started") }} />
        <h2 className="pt-2 text-lg font-semibold">{tr("assistant.admin.eval.results")}</h2>
        {summary.runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tr("assistant.admin.eval.empty")}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {summary.runs.map((r) => (
              <div key={`${r.runKey}-${r.model}`} className="grid gap-1 rounded-2xl border p-4">
                <code className="truncate text-xs text-muted-foreground">{r.model}</code>
                <p className="text-2xl font-semibold tabular-nums">{r.judged ? `${Math.round((r.passed / r.judged) * 100)}%` : "–"}</p>
                <p className="text-xs">{tr("assistant.admin.eval.passRate", { passed: r.passed, total: r.total })}</p>
                <p className="text-xs text-muted-foreground">
                  {tr("assistant.admin.eval.avgCost")} {usd(r.avgCostCents)} · {tr("assistant.admin.eval.avgMs")} {(r.avgMs / 1000).toFixed(1)} s
                </p>
                <p className="text-[11px] text-muted-foreground">{formatDateTime(r.at, locale)}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className={`${SURFACE} grid gap-4 p-5`}>
        <h2 className="text-lg font-semibold">{tr("assistant.admin.eval.cases")}</h2>
        <AddCase labels={{ question: tr("assistant.admin.eval.question"), expectation: tr("assistant.admin.eval.expectation"), add: tr("assistant.admin.eval.add") }} />
        <ol className="grid gap-3">
          {summary.cases.map((c) => {
            const answers = summary.latest.get(c.id) ?? [];
            return (
              <li key={c.id} className="grid gap-2 rounded-2xl border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">
                      <span className="mr-2 rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal">{c.locale.slice(0, 2).toUpperCase()}</span>
                      {c.question}
                    </p>
                    <p className="text-xs text-muted-foreground">✓ {c.expectation}</p>
                  </div>
                  <DeleteCase id={c.id} label={tr("assistant.admin.eval.delete")} />
                </div>
                {answers.length ? (
                  <div className="grid gap-2 lg:grid-cols-2">
                    {answers.map((a) => (
                      <div key={a.model} className={`rounded-xl p-3 text-xs ${a.passed === 1 ? "bg-[#e7f1ea]" : a.passed === 0 ? "bg-[#fdecea]" : "bg-muted/60"}`}>
                        <p className="mb-1 flex justify-between gap-2 font-semibold">
                          <code className="truncate">{a.model}</code>
                          <span className="shrink-0 font-normal text-muted-foreground">
                            {usd(a.costCents)} · {(a.ms / 1000).toFixed(1)} s
                          </span>
                        </p>
                        <p className="whitespace-pre-wrap">{a.answer}</p>
                        {a.verdict ? <p className="mt-1.5 border-t border-black/5 pt-1.5 italic">{a.passed === 1 ? "✓" : "✗"} {a.verdict}</p> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
