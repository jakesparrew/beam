/**
 * The evaluation set (docs/plan/modules/assistant.md section 3.2): every case is answered by the
 * chosen model exactly as a visitor would get it (same prompt, same tools, real availability), then
 * the analyst model judges the answer against the expectation. Staff compare models on quality,
 * cost per answer and speed before switching.
 */
import "server-only";
import { z } from "zod";
import { isLocale, type Locale } from "@beam/core/i18n";
import { assistantEvalCases, assistantEvalRuns } from "@beam/db/schema";
import type { JobCtx } from "@/lib/job-runner";
import { getSetting } from "@/lib/settings";
import type { AssistantSettingValue } from "../config";
import { runTurn } from "./agent";
import { parseJsonObject } from "./analyse";
import { chatClient } from "./client";
import { costCentsOf } from "./cost";
import { contextText, knowledgeText, systemPrompt } from "./prompt";
import { logModelCall, toolFact } from "./store";

const Verdict = z.object({ pass: z.boolean(), reason: z.string().max(400) });

const JUDGE = `You judge one answer of BEAM's website assistant. You get the visitor's question, the live data its tools returned, what a good answer must do (the expectation, written by BEAM's staff) and the answer (with the cards the widget showed). Return ONLY JSON: {"pass": true|false, "reason": "one short sentence in Dutch"}. Pass when the answer meets the expectation and invents no facts.`;

export async function runEval(ctx: JobCtx, input: { run_key: string; model: string }): Promise<void> {
  const tx = ctx.tx;
  const base = (await getSetting(tx, "assistant")) as AssistantSettingValue;
  const settings: AssistantSettingValue = { ...base, roles: { ...base.roles, guide: { ...base.roles.guide, model: input.model, fallback: null }, coach: { ...base.roles.coach, model: input.model, fallback: null } } };
  const cases = await tx.select().from(assistantEvalCases).orderBy(assistantEvalCases.createdAt);
  for (const c of cases) {
    const locale: Locale = isLocale(c.locale) ? c.locale : "nl-BE";
    const role = c.role === "coach" ? "guide" : c.role;
    const knowledge = await knowledgeText(tx, locale);
    const system = systemPrompt(role, locale, settings.tone, knowledge);
    const context = await contextText(tx, { now: ctx.now, locale, page: null, messageCount: 1, contactKnown: false, contactOffered: false, contactAfterMessages: settings.contact_after_messages });
    let answer: string;
    let facts = "";
    let cost = 0;
    let ms = 0;
    try {
      const r = await runTurn({
        settings,
        role,
        locale,
        system,
        context,
        history: [{ role: "user", content: c.question }],
        toolCtx: { db: tx, locale, role, personId: null, contactKnown: false, checkins: "no_consent", now: ctx.now, effects: { contactOffered: false, handoff: null, unanswered: [], bookingLinks: 0, shownLinks: [] } },
        emit: () => {},
      });
      const cards = r.cards.map((card) => (card.type === "sessions" ? `[sessions: ${card.sessions.length}]` : card.type === "link" ? `[button: ${card.label}]` : `[${card.type} form]`));
      answer = [r.text, ...cards].join("\n");
      facts = r.tools.map(toolFact).join("\n");
      cost = r.costCents;
      ms = r.durationMs;
      await logModelCall(tx, { feature: "assistant.eval", model: r.model, actor: ctx.actor, personId: null, prompt: c.question, output: answer, usage: r.usage, costCents: r.costCents, status: "ok", durationMs: r.durationMs });
    } catch (error) {
      answer = `(error: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"})`;
    }

    let passed: number | null = null;
    let verdict: string | null = null;
    try {
      const judge = base.roles.analyst;
      const j = await chatClient().stream(
        { model: judge.model, fallbackModel: judge.fallback, system: JUDGE, messages: [{ role: "user", content: `QUESTION:\n${c.question}\n\nEXPECTATION:\n${c.expectation}\n\nLIVE DATA FROM THE ASSISTANT'S TOOLS (facts taken from here are not invented):\n${facts || "(none)"}\n\nANSWER:\n${answer}` }], maxTokens: 400, effort: "low" },
        () => {},
      );
      const v = Verdict.safeParse(parseJsonObject(j.text));
      if (v.success) {
        passed = v.data.pass ? 1 : 0;
        verdict = v.data.reason;
      }
      const judgeCost = costCentsOf(base.models, j.model, j.usage);
      await logModelCall(tx, { feature: "assistant.eval", model: j.model, actor: ctx.actor, personId: null, prompt: `[judge] ${c.question}`, output: j.text, usage: j.usage, costCents: judgeCost, status: v.success ? "ok" : "error", durationMs: 0 });
    } catch {
      verdict = null;
    }
    await tx.insert(assistantEvalRuns).values({ runKey: input.run_key, caseId: c.id, model: input.model, answer: answer.slice(0, 6000), passed, verdict, costCents: String(cost), durationMs: ms });
  }
}
