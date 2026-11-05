/**
 * The weekly management summary (ops rule 78, R4): `ai.weekly_summary` (Monday 06:30, and
 * regenerations) and `ai.weekly_summary_collect`.
 *
 * - The prompt holds aggregates only: the rule 34-38 KPIs of the week and the week before
 *   (`evaluateKpi`, period `week`) and the retention list counts per reason. No person id, name
 *   or row ever reaches it.
 * - One Message Batch (half price) with one request per locale of the active owner and
 *   management users (`en` when there is none), submitted with platform's Claude client.
 * - The collect job polls the batch every 10 minutes, at most 36 times (6 hours), then stores
 *   each locale's text in `management_summaries.summary`, sets `ready` and posts the link to
 *   Slack. Every batch request becomes one `ai_requests` row, written when its result is read.
 * - A regeneration (key `summary:<weekStartOn>:regen:<n>`) sets a finished row back to `pending`;
 *   `kpis.generation` keeps `n`, so a second run of the same job does nothing.
 * - A spent budget or daily cap ends the row `skipped_budget` with one `budget_exceeded`
 *   `ai_requests` row per locale and a Slack line, and no batch.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { managementSummaries, roles, users } from "@beam/db/schema";
import { AI_FEATURES, costCents, modelIdFor, pricingFor, type AiPricing } from "@beam/core/ai";
import { brusselsDate, brusselsMidnight, KPI_REGISTRY, type KpiKey, periodRange, type RetentionReason } from "@beam/core/ops";
import { LOCALES, type Locale } from "@beam/core/i18n";
import type { ClaudeBatchItem, ClaudeRequest } from "@beam/integrations/anthropic";
import { and, eq, inArray, sql, type Actor } from "@/lib/ctx";
import { checkAiBatchBudget, logAiBatchRequests, type AiBatchRow } from "@/lib/ai";
import type { JobCtx } from "@/lib/job-runner";
import { rowsOf } from "@/lib/sensitive";
import { getSetting, notifySlack } from "@/modules/platform/api";
import { evaluateKpi } from "../insights/evaluate-kpi";

/** Rules 34-38: revenue, sales mix, customers, retention, B2B. */
export const SUMMARY_KPIS = [
  "revenue_net",
  "revenue_sales",
  "revenue_refunds",
  "revenue_orders",
  "sales_by_kind",
  "sales_by_channel",
  "customers_new",
  "customers_active",
  "customers_returning",
  "customers_dormant",
  "customers_reactivated",
  "repeat_purchase_rate",
  "package_completion_rate",
  "reactivation_rate",
  "membership_renewal_rate",
  "b2b_pipeline_value",
  "b2b_weighted_value",
  "b2b_qualified",
  "b2b_proposals",
  "b2b_conversion",
  "b2b_revenue",
] as const satisfies readonly KpiKey[];

export const COLLECT_EVERY_MS = 10 * 60_000;
export const COLLECT_MAX_POLLS = 36;
export const SUMMARY_FEATURE = "ai.weekly_summary" as const;

/** The structured answer of each batch request (the fake's default answer has this shape). */
export const SummaryOutput = z.object({ headline: z.string().min(1).max(300), points: z.array(z.string().max(500)).max(12) });

export type SummaryKpi = { key: string; unit: string; current: number | null; previous: number | null; changePct: number | null; breakdown?: { key: string; current: number; previous: number | null }[] };
export type SummaryKpis = {
  weekStartOn: string;
  kpis: SummaryKpi[];
  retentionByReason: Partial<Record<RetentionReason, number>>;
  /** 0 for the scheduled run, `n` for regeneration `n`. */
  generation: number;
  locales: Locale[];
};

const LANGUAGE: Record<Locale, string> = { "nl-BE": "Dutch (Belgium)", "fr-BE": "French (Belgium)", en: "English" };

/** Monday of the Brussels week before the one holding `now`. */
export function lastWeekStart(now: Date): string {
  return brusselsDate(periodRange("week", now).prevFrom);
}

/** An instant inside the week of `weekStartOn` (Thursday noon, Brussels), for `periodRange('week', at)`. */
function insideWeek(weekStartOn: string): Date {
  const [y, m, d] = weekStartOn.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + 3));
  const thursday = brusselsMidnight({ year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() });
  return new Date(thursday.getTime() + 12 * 3_600_000);
}

/** The regeneration number of a job key (`summary:<week>:regen:<n>`), 0 for the scheduled run. */
export function generationOf(key: string): number {
  const m = /:regen:(\d+)$/.exec(key);
  return m ? Number(m[1]) : 0;
}

/** The batch `custom_id` of a locale (`summary-2026-10-26-nl_BE-g0`). */
export function customIdFor(weekStartOn: string, locale: Locale, generation: number): string {
  return `summary-${weekStartOn}-${locale.replace("-", "_")}-g${generation}`;
}

export function localeOfCustomId(customId: string): Locale | null {
  const m = /-([a-z]{2}(?:_[A-Z]{2})?)-g\d+$/.exec(customId);
  const locale = m?.[1]?.replace("_", "-");
  return locale && (LOCALES as readonly string[]).includes(locale) ? (locale as Locale) : null;
}

/** A read context with `reports.read` only, for the KPI functions inside the job (no person data is read out). */
function kpiReadCtx(ctx: JobCtx): { tx: JobCtx["tx"]; actor: Actor; now: Date; locale: Locale } {
  const actor: Actor = { kind: "staff", userId: "00000000-0000-0000-0000-000000000000", roleKey: "management", permissions: new Set(["reports.read"]), mfaAt: ctx.now };
  return { tx: ctx.tx, actor, now: ctx.now, locale: "en" };
}

/** The aggregates of rule 78 for the week of `weekStartOn` and the week before. */
export async function collectSummaryKpis(ctx: JobCtx, weekStartOn: string): Promise<Pick<SummaryKpis, "kpis" | "retentionByReason">> {
  const read = kpiReadCtx(ctx);
  const at = insideWeek(weekStartOn);
  const kpis: SummaryKpi[] = [];
  for (const key of SUMMARY_KPIS) {
    try {
      const v = await evaluateKpi(read, key, { period: KPI_REGISTRY[key].snapshot ? "day" : "week", at, compare: true });
      kpis.push({
        key,
        unit: v.unit,
        current: v.current,
        previous: v.previous,
        changePct: v.changePct,
        ...(v.breakdown ? { breakdown: v.breakdown.map((b) => ({ key: b.key, current: b.current, previous: b.previous })) } : {}),
      });
    } catch {
      // A KPI whose source fails is left out; the rest still go.
    }
  }
  const counts = rowsOf<{ reason: RetentionReason; n: number }>(
    await ctx.tx.execute(sql`select reason, count(distinct person_id)::int as n from v_retention_candidates group by reason order by reason`),
  );
  return { kpis, retentionByReason: Object.fromEntries(counts.map((c) => [c.reason, Number(c.n)])) };
}

/** Locales of active owner and management users, in catalogue order; `en` when there is none. */
export async function summaryLocales(ctx: JobCtx): Promise<Locale[]> {
  const rows = await ctx.tx
    .selectDistinct({ locale: users.locale })
    .from(users)
    .innerJoin(roles, eq(roles.key, users.roleKey))
    .where(and(inArray(users.roleKey, ["owner", "management"]), eq(users.status, "active"), eq(users.audience, "staff")));
  const used = new Set(rows.map((r) => r.locale));
  const out = LOCALES.filter((l) => used.has(l));
  return out.length ? [...out] : ["en"];
}

/** The system prompt and the one user message of a locale's request (aggregates only). */
export function summaryPrompt(k: SummaryKpis, locale: Locale): { system: string; user: string } {
  const system = [
    "You write BEAM Vitality Center's weekly management summary for the owner and managers.",
    `Write in ${LANGUAGE[locale]}. Return a headline (one sentence) and three to eight short points.`,
    "Use only the figures given. Amounts in *_cents are euro cents (divide by 100). Percentages are 0-100.",
    "Compare the week with the week before, name the biggest changes and what deserves attention. No invented figures.",
  ].join("\n");
  const user = JSON.stringify({ weekStartOn: k.weekStartOn, kpis: k.kpis, retentionListByReason: k.retentionByReason });
  return { system, user };
}

function requestFor(k: SummaryKpis, locale: Locale): ClaudeRequest {
  const p = summaryPrompt(k, locale);
  return {
    feature: SUMMARY_FEATURE,
    model: modelIdFor(AI_FEATURES[SUMMARY_FEATURE].model),
    system: p.system,
    messages: [{ role: "user", content: p.user }],
    maxTokens: 1500,
    effort: AI_FEATURES[SUMMARY_FEATURE].effort,
    outputSchema: z.toJSONSchema(SummaryOutput),
  };
}

const promptText = (r: ClaudeRequest) => [`[system]\n${r.system}`, ...r.messages.map((m) => `[${m.role}]\n${m.content}`)].join("\n\n");

type AiSetting = { pricing: AiPricing };

async function loadRow(ctx: JobCtx, weekStartOn: string) {
  const [row] = await ctx.tx.select().from(managementSummaries).where(eq(managementSummaries.weekStartOn, weekStartOn)).for("update");
  return row;
}

export type WeeklySummaryResult =
  | { status: "pending"; weekStartOn: string; batchId: string; locales: Locale[] }
  | { status: "skipped_budget"; weekStartOn: string }
  | { status: "skipped"; weekStartOn: string; reason: "flag_off" | "already_done" | "batch_running" };

/** `ai.weekly_summary`: the aggregates, one batch, the `pending` row and the first collect job. */
export async function startWeeklySummary(ctx: JobCtx, input: { weekStartOn?: string | undefined }): Promise<WeeklySummaryResult> {
  const weekStartOn = input.weekStartOn ?? lastWeekStart(ctx.now);
  const generation = generationOf(ctx.job.key);
  const existing = await loadRow(ctx, weekStartOn);
  if (existing) {
    const done = Number((existing.kpis as { generation?: unknown }).generation ?? 0);
    if (existing.status === "pending" && existing.batchId) return { status: "skipped", weekStartOn, reason: "batch_running" };
    if (generation === 0 || generation <= done) return { status: "skipped", weekStartOn, reason: "already_done" };
  }

  const aggregates = await collectSummaryKpis(ctx, weekStartOn);
  const locales = await summaryLocales(ctx);
  const k: SummaryKpis = { weekStartOn, ...aggregates, generation, locales };
  const model = modelIdFor(AI_FEATURES[SUMMARY_FEATURE].model);
  const requests = locales.map((l) => ({ customId: customIdFor(weekStartOn, l, generation), request: requestFor(k, l) }) satisfies ClaudeBatchItem);

  // PL-56 for the batch: the monthly budget and the daily cap must leave room for every request.
  const budget = await checkAiBatchBudget(ctx, requests.length);
  const values = { kpis: k as unknown as Record<string, unknown>, updatedAt: ctx.now };
  if (!budget.ok) {
    await logAiBatchRequests(ctx, { feature: SUMMARY_FEATURE, model }, requests.map((r) => ({ status: "budget_exceeded", prompt: promptText(r.request), error: "budget" })));
    await ctx.tx
      .insert(managementSummaries)
      .values({ weekStartOn, summary: {}, status: "skipped_budget", batchId: null, ...values })
      .onConflictDoUpdate({ target: managementSummaries.weekStartOn, set: { status: "skipped_budget", batchId: null, ...values } });
    await notifySlack(ctx, { fingerprint: `weekly-summary-budget-${weekStartOn}`, severity: "normal", text: `The weekly management summary for the week of ${weekStartOn} was skipped: the AI budget or daily cap is spent.` });
    return { status: "skipped_budget", weekStartOn };
  }

  const batch = await ctx.integrations.anthropic.createBatch(requests);
  await ctx.tx
    .insert(managementSummaries)
    .values({ weekStartOn, summary: {}, status: "pending", batchId: batch.id, ...values })
    .onConflictDoUpdate({ target: managementSummaries.weekStartOn, set: { status: "pending", batchId: batch.id, ...values } });
  await ctx.enqueue({
    kind: "ai.weekly_summary_collect",
    payload: { weekStartOn, batchId: batch.id, n: 0 },
    key: `summary:${weekStartOn}:collect:${batch.id}:0`,
    runAt: new Date(ctx.now.getTime() + COLLECT_EVERY_MS),
  });
  return { status: "pending", weekStartOn, batchId: batch.id, locales };
}

/** The summary page of a week (the Slack link). */
export function summaryUrl(weekStartOn: string): string {
  return `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}/admin/dashboard/summary?week=${weekStartOn}`;
}

/** Markdown of one structured answer. */
export function summaryMarkdown(out: z.infer<typeof SummaryOutput>): string {
  return [`**${out.headline.trim()}**`, "", ...out.points.map((p) => `- ${p.trim()}`)].join("\n");
}

function parseAnswer(text: string, json: unknown): z.infer<typeof SummaryOutput> | null {
  let value = json;
  if (value === null || value === undefined) {
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }
  const parsed = SummaryOutput.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export type CollectResult =
  | { status: "running"; next: number }
  | { status: "ready" | "failed"; weekStartOn: string; locales: Locale[] }
  | { status: "skipped"; reason: "flag_off" | "stale" };

/** `ai.weekly_summary_collect`: polls the batch; when ended stores the texts and posts the link. */
export async function collectWeeklySummary(ctx: JobCtx, input: { weekStartOn: string; batchId: string; n: number }): Promise<CollectResult> {
  const row = await loadRow(ctx, input.weekStartOn);
  if (!row || row.batchId !== input.batchId || row.status !== "pending") return { status: "skipped", reason: "stale" };
  const k = row.kpis as unknown as SummaryKpis;
  const model = modelIdFor(AI_FEATURES[SUMMARY_FEATURE].model);
  const locales = (k.locales ?? []).filter((l) => (LOCALES as readonly string[]).includes(l));

  const batch = await ctx.integrations.anthropic.getBatch(input.batchId);
  if (batch.status !== "ended") {
    if (input.n + 1 < COLLECT_MAX_POLLS) {
      const n = input.n + 1;
      await ctx.enqueue({
        kind: "ai.weekly_summary_collect",
        payload: { weekStartOn: input.weekStartOn, batchId: input.batchId, n },
        key: `summary:${input.weekStartOn}:collect:${input.batchId}:${n}`,
        runAt: new Date(ctx.now.getTime() + COLLECT_EVERY_MS),
      });
      return { status: "running", next: n };
    }
    // Six hours without an end: every request is logged as failed and the row fails.
    await logAiBatchRequests(ctx, { feature: SUMMARY_FEATURE, model }, locales.map((l) => ({ status: "error", prompt: promptText(requestFor(k, l)), error: `batch_not_ended:${batch.status}` })));
    await ctx.tx.update(managementSummaries).set({ status: "failed", updatedAt: ctx.now }).where(eq(managementSummaries.id, row.id));
    await notifySlack(ctx, { fingerprint: `weekly-summary-failed-${input.weekStartOn}`, severity: "normal", text: `The weekly management summary for the week of ${input.weekStartOn} failed: the batch did not end within 6 hours.` });
    return { status: "failed", weekStartOn: input.weekStartOn, locales: [] };
  }

  const ai = (await getSetting(ctx.tx, "ai")) as AiSetting;
  const results = await ctx.integrations.anthropic.getBatchResults(input.batchId);
  const summary: Record<string, string> = {};
  const logged: AiBatchRow[] = [];
  const ids: string[] = [];
  for (const r of results) {
    const locale = localeOfCustomId(r.customId);
    if (!locale) continue;
    const prompt = promptText(requestFor(k, locale));
    const id = randomUUID();
    if (!r.response) {
      logged.push({ id, status: "error", prompt, error: r.error ?? "errored" });
    } else {
      const usage = r.response.usage;
      const cost = costCents(usage, pricingFor(model, ai.pricing), { batch: true });
      const answer = r.response.stopReason === "refusal" ? null : parseAnswer(r.response.text, r.response.json);
      if (answer) summary[locale] = summaryMarkdown(answer);
      logged.push({
        id,
        status: answer ? "ok" : "error",
        prompt,
        output: r.response.text || null,
        error: answer ? null : r.response.stopReason === "refusal" ? `refusal:${r.response.refusalCategory ?? "unknown"}` : "invalid_output",
        usage,
        costCents: cost,
      });
    }
    ids.push(id);
  }
  await logAiBatchRequests(ctx, { feature: SUMMARY_FEATURE, model }, logged);
  const stored = Object.keys(summary) as Locale[];
  const status = stored.length ? "ready" : "failed";
  // A regeneration that produced nothing keeps the earlier texts.
  const next = stored.length ? summary : (row.summary as Record<string, string>);
  await ctx.tx
    .update(managementSummaries)
    .set({ status, summary: next, aiRequestIds: sql`${managementSummaries.aiRequestIds} || ${`{${ids.join(",")}}`}::uuid[]`, updatedAt: ctx.now })
    .where(eq(managementSummaries.id, row.id));
  await notifySlack(ctx, {
    fingerprint: `weekly-summary-${input.weekStartOn}`,
    severity: "normal",
    text:
      status === "ready"
        ? `The weekly management summary for the week of ${input.weekStartOn} is ready: ${summaryUrl(input.weekStartOn)}`
        : `The weekly management summary for the week of ${input.weekStartOn} failed: no locale came back.`,
  });
  return { status, weekStartOn: input.weekStartOn, locales: stored };
}
