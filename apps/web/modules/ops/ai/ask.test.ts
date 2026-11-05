/**
 * ops-P10, rule 77: natural-language questions with the fake Claude gateway on PGlite (`0100` and
 * `0101` applied). Claude's SQL is scripted per test; the explanation call is told apart by its
 * system prompt (`EXPLAIN_SYSTEM_PREFIX`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { Db, DbHandle } from "@beam/db";
import { dpiaRecords, featureFlags, nlQuestions, settings } from "@beam/db/schema";
import { applyCustomSql, createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import type { ClaudeRequest } from "@beam/integrations/anthropic";
import { eq } from "@/lib/ctx";
import { getSetting } from "@/lib/settings";
import { createFakeIntegrations, makeJobCtx, type FakeIntegrations } from "@/lib/testing";
import { rowsOf } from "@/lib/sensitive";
import type * as PlatformApi from "@/modules/platform/api";

vi.mock("@/modules/platform/api", async (orig) => {
  const m = await orig<typeof PlatformApi>();
  return { ...m, runAiReadOnlyQuery: vi.fn(m.runAiReadOnlyQuery) };
});

const platformApi = await import("@/modules/platform/api");
const { answerQuestion, EXPLAIN_SYSTEM_PREFIX, explanationPayload } = await import("./ask");
const { runAnswerQuestion } = await import("./jobs");

let handle: DbHandle;
let db: Db;
let fakes: FakeIntegrations;
let userId: string;
const people: { id: string; firstName: string; lastName: string }[] = [];
let defaultAi: Record<string, unknown>;

const q = async <T>(text: string) => rowsOf<T>(await db.execute(sql.raw(text)));

/** Scripts the SQL answer; the explanation call gets `explanation`. */
function script(answer: { sql: string; refusal?: string | null }, explanation = "Lotte leads this year.") {
  fakes.anthropic.script("ai.answer_question", (req: ClaudeRequest) => (req.system.startsWith(EXPLAIN_SYSTEM_PREFIX) ? { explanation } : answer));
}

async function ask(question: string) {
  const [row] = await db.insert(nlQuestions).values({ userId, question, status: "error" }).returning({ id: nlQuestions.id });
  const ctx = makeJobCtx(db, "ai.answer_question", { integrations: fakes, key: `question:${row!.id}` });
  return { id: row!.id, out: await answerQuestion(ctx, row!.id) };
}

async function setDpia(approved: boolean) {
  await db
    .insert(dpiaRecords)
    .values({ key: "ai_customer_ranking", status: approved ? "approved" : "not_started", decisionNote: approved ? "test" : null })
    .onConflictDoUpdate({ target: dpiaRecords.key, set: { status: approved ? "approved" : "not_started", decisionNote: approved ? "test" : null } });
}

beforeAll(async () => {
  handle = await createTestDb();
  db = handle.db;
  await applyCustomSql(handle, { files: ["0100_ai_readonly.sql", "0101_ai_views_ops.sql"] });
  await db.insert(featureFlags).values({ key: "ff_ops_ai", state: "on" }).onConflictDoUpdate({ target: featureFlags.key, set: { state: "on" } });
  userId = (await makeUser(db, { roleKey: "management", locale: "fr-BE" })).id;
  for (const [i, name] of ["Lotte", "Jan", "Sofie"].entries()) {
    const p = await makePerson(db, { firstName: name, lastName: `Lastname${name}Ask`, email: `${name.toLowerCase()}.ask@example.com`, isTester: false });
    people.push({ id: p.id, firstName: name, lastName: `Lastname${name}Ask` });
    for (let k = 0; k < 5; k++) await makePaidOrder(db, { personId: p.id, order: { paidAt: new Date(Date.UTC(2026, 9, 1 + i * 5 + k, 10)) } });
  }
  defaultAi = (await getSetting(db, "ai"));
}, 120_000);
afterAll(() => handle.close());
beforeEach(async () => {
  fakes = createFakeIntegrations();
  vi.mocked(platformApi.runAiReadOnlyQuery).mockClear();
  await setDpia(true);
  await db.insert(settings).values({ key: "ai", value: defaultAi }).onConflictDoUpdate({ target: settings.key, set: { value: defaultAi } });
});

const TOP = "select o.person_id, count(*) as orders, sum(o.total_cents) as revenue_cents from ai.orders o group by o.person_id order by revenue_cents desc";

describe("answerQuestion (rule 77)", () => {
  it("runs Claude's SQL as beam_ai_ro, explains it without person ids or names, and stores the question", async () => {
    script({ sql: TOP });
    const { id, out } = await ask("Which customers generated the most revenue this year?");
    expect(out.status).toBe("answered");
    expect(out.columns).toEqual(["person_id", "orders", "revenue_cents"]);
    expect(out.rows).toHaveLength(3);
    expect(out.sql).toBe(`${TOP}\nlimit 200`);
    expect(out.explanation).toBe("Lotte leads this year.");

    // Two Claude calls: the SQL (schema description + question) and the explanation.
    const calls = fakes.anthropic.calls.map((c) => c.input);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.system).toContain("ai.customers");
    expect(calls[0]!.messages[0]!.content).toBe("Which customers generated the most revenue this year?");
    const second = JSON.stringify(calls[1]);
    expect(calls[1]!.system).toContain("French");
    for (const p of people) {
      expect(second).not.toContain(p.id);
      expect(second).not.toContain(p.lastName);
    }
    expect(second).not.toContain("person_id");
    expect(second).toContain("revenue_cents");

    const [row] = await db.select().from(nlQuestions).where(eq(nlQuestions.id, id));
    expect(row).toMatchObject({ status: "answered", rowCount: 3, columns: ["person_id", "orders", "revenue_cents"], generatedSql: `${TOP}\nlimit 200`, explanation: "Lotte leads this year." });
    expect(row!.aiRequestIds).toHaveLength(2);
    const logged = await q<{ id: string; status: string; prompt: string }>(`select id::text as id, status::text as status, prompt from ai_requests where feature = 'ai.answer_question' order by created_at, id`);
    expect(logged.filter((r) => row!.aiRequestIds.includes(r.id)).every((r) => r.status === "ok")).toBe(true);
    expect(logged.some((r) => r.prompt.startsWith("[sql]") && r.prompt.includes("from ai.orders"))).toBe(true);
  });

  it("caps the rows at 200, with or without Claude's own limit", async () => {
    const cross = "select a.order_id, b.order_id as other_id from ai.orders a cross join ai.orders b";
    script({ sql: cross });
    const one = await ask("All pairs of orders");
    expect(one.out.status).toBe("answered");
    expect(one.out.rows).toHaveLength(200);
    script({ sql: `${cross} limit 1000` });
    const two = await ask("All pairs of orders, at most 1000");
    expect(two.out.rows).toHaveLength(200);
    expect(two.out.sql).toMatch(/\) as answer limit 200$/);
    // At most 200 rows go into the explanation prompt.
    const payload = JSON.parse(explanationPayload("q", one.out.columns, [...one.out.rows, ...one.out.rows])) as { rows: unknown[] };
    expect(payload.rows).toHaveLength(200);
  });

  it("refused: Claude's refusal, a refusal stop, SQL outside ai, and a DPIA-gated view", async () => {
    script({ sql: "", refusal: "Contact data is not available." });
    expect((await ask("What is Lotte's phone number?")).out).toMatchObject({ status: "refused", explanation: "Contact data is not available.", rows: [] });

    fakes.anthropic.failNext("refusal");
    expect((await ask("Something harmful")).out.status).toBe("refused");

    script({ sql: "select email from public.persons" });
    const outside = await ask("Emails please");
    expect(outside.out.status).toBe("refused");
    expect(outside.out.explanation).toMatch(/relation_outside_ai/);

    await setDpia(false);
    script({ sql: "select person_id, reason from ai.retention_candidates" });
    const gated = await ask("Who should we contact this week?");
    expect(gated.out.status).toBe("refused");
    expect(gated.out.explanation).toMatch(/dpia_not_approved/);
    // Nothing reached the read-only runner for these four.
    expect(platformApi.runAiReadOnlyQuery).not.toHaveBeenCalled();
  });

  it("timeout: a statement cancelled after 5 s ends as timeout", async () => {
    script({ sql: TOP });
    vi.mocked(platformApi.runAiReadOnlyQuery).mockRejectedValueOnce(new platformApi.AiSqlRunError("timeout", "canceling statement due to statement timeout"));
    const { id, out } = await ask("A slow question");
    expect(out.status).toBe("timeout");
    const [row] = await db.select({ status: nlQuestions.status, generatedSql: nlQuestions.generatedSql }).from(nlQuestions).where(eq(nlQuestions.id, id));
    expect(row).toEqual({ status: "timeout", generatedSql: `${TOP}\nlimit 200` });
  });

  it("budget: a spent monthly budget ends as budget_exceeded with a budget_exceeded ai_requests row", async () => {
    await db.update(settings).set({ value: { ...defaultAi, monthly_budget_cents: 0 } }).where(eq(settings.key, "ai"));
    script({ sql: TOP });
    const before = await q<{ n: number }>("select count(*)::int as n from ai_requests where status = 'budget_exceeded'");
    const { out } = await ask("Revenue this year?");
    expect(out.status).toBe("budget_exceeded");
    expect(fakes.anthropic.calls).toHaveLength(0);
    const after = await q<{ n: number }>("select count(*)::int as n from ai_requests where status = 'budget_exceeded'");
    expect(after[0]!.n).toBe(before[0]!.n + 1);
  });

  it("the job returns early while ff_ops_ai is off", async () => {
    await db.update(featureFlags).set({ state: "off" }).where(eq(featureFlags.key, "ff_ops_ai"));
    try {
      const [row] = await db.insert(nlQuestions).values({ userId, question: "Revenue?", status: "error" }).returning({ id: nlQuestions.id });
      const out = await runAnswerQuestion(makeJobCtx(db, "ai.answer_question", { integrations: fakes }), { questionId: row!.id });
      expect(out).toEqual({ status: "skipped", reason: "flag_off" });
      expect(fakes.anthropic.calls).toHaveLength(0);
    } finally {
      await db.update(featureFlags).set({ state: "on" }).where(eq(featureFlags.key, "ff_ops_ai"));
    }
  });
});
