/**
 * ops-P10: every `ai` job runs twice with the same payload (conventions item 11) and the second
 * run changes nothing: no second Claude call, no second batch, no second set of `ai_requests` rows.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Db, DbHandle } from "@beam/db";
import { dpiaRecords, featureFlags, managementSummaries, nlQuestions } from "@beam/db/schema";
import { applyCustomSql, createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { eq } from "@/lib/ctx";
import { createFakeIntegrations, runJobTwice } from "@/lib/testing";
import { rowsOf } from "@/lib/sensitive";

let handle: DbHandle;
let db: Db;
let userId: string;

const count = async (where: string) => Number(rowsOf<{ n: number }>(await db.execute(sql.raw(`select count(*)::int as n from ${where}`)))[0]!.n);

beforeAll(async () => {
  handle = await createTestDb();
  db = handle.db;
  await applyCustomSql(handle, { files: ["0100_ai_readonly.sql", "0101_ai_views_ops.sql"] });
  await db.insert(featureFlags).values({ key: "ff_ops_ai", state: "on" }).onConflictDoUpdate({ target: featureFlags.key, set: { state: "on" } });
  await db.insert(dpiaRecords).values({ key: "ai_customer_ranking", status: "approved", decisionNote: "test" }).onConflictDoNothing();
  userId = (await makeUser(db, { roleKey: "owner", locale: "en" })).id;
  const p = await makePerson(db, { firstName: "Wout", email: "wout.ai-jobs@example.com", isTester: false });
  await makePaidOrder(db, { personId: p.id, order: { paidAt: new Date() } });
}, 120_000);
afterAll(() => handle.close());

describe("ai jobs run twice", () => {
  it("ai.answer_question: the second run asks Claude nothing and keeps the answer", async () => {
    const fakes = createFakeIntegrations();
    fakes.anthropic.script("ai.answer_question", (req) =>
      req.system.startsWith("You explain") ? { explanation: "One customer." } : { sql: "select person_id, first_name, revenue_cents from ai.customers order by revenue_cents desc" },
    );
    const [q] = await db.insert(nlQuestions).values({ userId, question: "Top customers?", status: "error" }).returning({ id: nlQuestions.id });
    const { first, second } = await runJobTwice(db, "ai.answer_question", { questionId: q!.id }, { integrations: fakes });
    expect(first).toMatchObject({ status: "answered", columns: ["person_id", "first_name", "revenue_cents"] });
    expect(second).toMatchObject({ status: "answered", columns: ["person_id", "first_name", "revenue_cents"], explanation: "One customer." });
    expect((second as { rows: unknown[] }).rows).toEqual((first as { rows: unknown[] }).rows);
    expect(fakes.anthropic.calls).toHaveLength(2);
    const [row] = await db.select({ ids: nlQuestions.aiRequestIds, status: nlQuestions.status }).from(nlQuestions).where(eq(nlQuestions.id, q!.id));
    expect(row).toMatchObject({ status: "answered" });
    expect(row!.ids).toHaveLength(2);
    expect(await count("ai_requests where feature = 'ai.answer_question' and prompt not like '[sql]%'")).toBe(2);
  });

  it("ai.weekly_summary and ai.weekly_summary_collect: one batch, one set of texts", async () => {
    const fakes = createFakeIntegrations();
    const weekStartOn = "2026-10-19";
    const start = await runJobTwice(db, "ai.weekly_summary", { weekStartOn }, { integrations: fakes });
    expect(start.first).toMatchObject({ status: "pending", weekStartOn });
    expect(start.second).toMatchObject({ status: "skipped", reason: "batch_running" });
    expect(fakes.anthropic.batches).toHaveLength(1);
    const batchId = fakes.anthropic.batches[0]!.id;

    const before = await count("ai_requests where feature = 'ai.weekly_summary'");
    const collect = await runJobTwice(db, "ai.weekly_summary_collect", { weekStartOn, batchId, n: 0 }, { integrations: fakes });
    expect(collect.first).toMatchObject({ status: "ready", locales: ["en"] });
    expect(collect.second).toEqual({ status: "skipped", reason: "stale" });
    expect(await count("ai_requests where feature = 'ai.weekly_summary'")).toBe(before + 1);
    const [row] = await db.select().from(managementSummaries).where(eq(managementSummaries.weekStartOn, weekStartOn));
    expect(row).toMatchObject({ status: "ready", batchId });
    expect(Object.keys(row!.summary)).toEqual(["en"]);
    expect(row!.aiRequestIds).toHaveLength(1);
  });
});
