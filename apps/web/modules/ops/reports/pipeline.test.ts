/**
 * The B2C pipeline board (ops rule 14a, ops-P7): the counts per stage match `person_stats`
 * (testers, erased, merged and restricted people left out), each column holds the most recent
 * stage changes first, high-value people of other stages carry the badge and the filters work.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { personStats } from "@beam/db/schema";
import { B2C_STAGES, type B2cStage } from "@beam/core/ops";
import { createTestDb } from "@beam/db/testing";
import { sql } from "@/lib/ctx";
import { resetRuntime, staffActor } from "@/lib/testing";
import { rowsOf } from "@/lib/sensitive";
import { ago, makeCustomer } from "../dashboard/ops-p3.fixtures";
import { getPipelineBoard } from "../retention/queries";
import { computePipelineBoard, PIPELINE_PAGE_SIZE } from "./pipeline";

let h: DbHandle;

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  await h.db.execute(sql`update persons set is_tester = true where is_tester = false`);
});

async function person(stage: B2cStage, opts: { changedDaysAgo?: number; revenueCents?: number; source?: string; campaign?: string; isTester?: boolean } = {}) {
  const p = await makeCustomer(h.db, {
    isTester: opts.isTester ?? false,
    acquisition: { source: opts.source ?? "site", ...(opts.campaign ? { campaign: opts.campaign } : {}) },
  });
  await h.db.insert(personStats).values({ personId: p.id, b2cStage: stage, b2cStageChangedAt: ago(opts.changedDaysAgo ?? 1), revenueCents: opts.revenueCents ?? 0, purchases: opts.revenueCents ? 1 : 0 });
  return p;
}

describe("rule 14a: getPipelineBoard", () => {
  it("counts per stage match person_stats of the real people on the board", async () => {
    await person("lead");
    await person("lead");
    await person("engaged_lead");
    await person("repeat", { revenueCents: 30_000 });
    await person("member", { revenueCents: 50_000 });
    await person("retention");
    await person("lost", { isTester: true });
    const erased = await person("lost");
    await h.db.execute(sql`update persons set erased_at = now() where id = ${erased.id}`);
    const restricted = await person("active");
    await h.db.execute(sql`update persons set processing_restricted_at = now() where id = ${restricted.id}`);

    const board = await computePipelineBoard(h.db);
    expect(board.columns.map((c) => c.stage)).toEqual([...B2C_STAGES]);
    const expected = rowsOf<{ stage: string; n: number }>(
      await h.db.execute(sql`select ps.b2c_stage::text as stage, count(*)::int as n from person_stats ps join persons pe on pe.id = ps.person_id
        where pe.is_tester = false and pe.erased_at is null and pe.merged_into_person_id is null and pe.processing_restricted_at is null
        group by 1`),
    );
    for (const col of board.columns) expect(col.count).toBe(Number(expected.find((e) => e.stage === col.stage)?.n ?? 0));
    expect(Object.fromEntries(board.columns.map((c) => [c.stage, c.count]))).toMatchObject({ lead: 2, engaged_lead: 1, repeat: 1, member: 1, retention: 1, lost: 0, active: 0 });
  });

  it("lists the most recent stage changes first and badges high-value people of any stage", async () => {
    const older = await person("repeat", { changedDaysAgo: 10 });
    const vip = await person("repeat", { changedDaysAgo: 2, revenueCents: 150_000 });
    const newest = await person("repeat", { changedDaysAgo: 1 });
    const board = await computePipelineBoard(h.db);
    const repeat = board.columns.find((c) => c.stage === "repeat")!;
    expect(repeat.people.map((p) => p.personId)).toEqual([newest.id, vip.id, older.id]);
    expect(repeat.highValueCount).toBe(1);
    expect(repeat.people.find((p) => p.personId === vip.id)).toMatchObject({ isHighValue: true, revenueCents: 150_000, stage: "repeat" });
    const onlyHigh = await computePipelineBoard(h.db, { filters: { highValue: true } });
    expect(onlyHigh.columns.find((c) => c.stage === "repeat")!.people.map((p) => p.personId)).toEqual([vip.id]);
  });

  it("filters by acquisition source and campaign; pages through one stage by 50", async () => {
    const meta = await person("lead", { source: "meta", campaign: "Spring-26" });
    await person("lead", { source: "google", campaign: "spring-26" });
    const bySource = await computePipelineBoard(h.db, { filters: { source: "META" } });
    expect(bySource.columns.find((c) => c.stage === "lead")!.people.map((p) => p.personId)).toEqual([meta.id]);
    const byCampaign = await computePipelineBoard(h.db, { filters: { campaign: "spring-26" } });
    expect(byCampaign.columns.find((c) => c.stage === "lead")!.count).toBe(2);

    for (let i = 0; i < PIPELINE_PAGE_SIZE + 1; i++) await person("first_visit", { changedDaysAgo: 1 + i / 100 });
    const page1 = await computePipelineBoard(h.db, { stage: "first_visit" });
    const page2 = await computePipelineBoard(h.db, { stage: "first_visit", page: 2 });
    expect(page1.columns.find((c) => c.stage === "first_visit")!.people).toHaveLength(PIPELINE_PAGE_SIZE);
    expect(page2.columns.find((c) => c.stage === "first_visit")!.people).toHaveLength(1);
    expect(page1.columns.find((c) => c.stage === "lead")!.people).toHaveLength(0);
  });

  it("needs reports.read", async () => {
    const ctx = { tx: h.db, actor: staffActor({ permissions: ["reports.read"] }), now: new Date(), locale: "en" as const };
    expect((await getPipelineBoard(ctx, { stage: "nonsense" })).columns).toHaveLength(B2C_STAGES.length);
    await expect(getPipelineBoard({ ...ctx, actor: staffActor({ permissions: ["tasks.all"] }) })).rejects.toMatchObject({ name: "ForbiddenError" });
  });
});
