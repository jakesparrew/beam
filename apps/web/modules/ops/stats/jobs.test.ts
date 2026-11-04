/**
 * ops stats jobs (spec 4.4): every job run twice gives the same rows; the nightly run's
 * continuation chunks of 2,000 cover 4,500 persons; the recent refresh advances
 * `ops_state.stats_cursor`; the digest posts once per day.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { activityEvents, jobs as jobsTable, personStats } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { and, asc, eq, sql } from "@/lib/ctx";
import { loadJobs } from "@/lib/job-runner";
import { fakeSentry, makeJobCtx, resetRuntime, runJobTwice } from "@/lib/testing";
import { NIGHTLY_CHUNK, nightlyKey } from "./jobs";
import { daysAgo, makeBooking, makeCustomer } from "./ops-p2.fixtures";

let h: DbHandle;
let sentry: ReturnType<typeof fakeSentry>;
beforeAll(async () => {
  h = await createTestDb();
  sentry = fakeSentry();
});
afterAll(async () => {
  sentry.restore();
  resetRuntime();
  await h.close();
});

/** Everything the stats jobs write, without the clock columns. */
async function snapshot() {
  const stats = (await h.db.select().from(personStats).orderBy(asc(personStats.personId))).map(({ computedAt: _c, updatedAt: _u, ...rest }) => rest);
  const events = await h.db.select({ kind: activityEvents.kind, key: activityEvents.dedupeKey }).from(activityEvents).orderBy(asc(activityEvents.id));
  const queued = await h.db.select({ kind: jobsTable.kind, key: jobsTable.idempotencyKey }).from(jobsTable).orderBy(asc(jobsTable.idempotencyKey));
  const state = (await h.db.execute(sql`select key, value from ops_state order by key`)) as unknown as { rows: unknown[] };
  return { stats, events, queued, state: state.rows };
}

async function twice(kind: Parameters<typeof runJobTwice>[1], payload: unknown) {
  let afterFirst: Awaited<ReturnType<typeof snapshot>> | undefined;
  await runJobTwice(h.db, kind, payload, { between: async () => void (afterFirst = await snapshot()) });
  expect(await snapshot()).toEqual(afterFirst);
}

describe("ops stats jobs run twice", () => {
  it("ops.refresh_person_stats", async () => {
    const p = await makeCustomer(h.db);
    await makePaidOrder(h.db, { personId: p.id, order: { paidAt: daysAgo(31) } });
    await makeBooking(h.db, { personId: p.id, startsAt: daysAgo(31), status: "attended" });
    await twice("ops.refresh_person_stats", { runOn: "2026-11-04" });
    const [row] = await h.db.select().from(personStats).where(eq(personStats.personId, p.id));
    expect(row).toMatchObject({ purchases: 1, visits: 1 });
    const inactive = await h.db.select().from(activityEvents).where(and(eq(activityEvents.personId, p.id), eq(activityEvents.kind, "person.inactive_days")));
    expect(inactive).toHaveLength(1);
  });

  it("ops.refresh_recent_stats", async () => {
    const p = await makeCustomer(h.db);
    await h.db.execute(sql`insert into activity_events (person_id, kind, actor, data) values (${p.id}, 'order.paid', '{"kind":"system","id":null}', '{}')`);
    await twice("ops.refresh_recent_stats", {});
    expect(await h.db.select().from(personStats).where(eq(personStats.personId, p.id))).toHaveLength(1);
  });

  it("ops.refresh_person", async () => {
    const p = await makeCustomer(h.db);
    await makeBooking(h.db, { personId: p.id, startsAt: daysAgo(3), status: "attended" });
    await twice("ops.refresh_person", { personId: p.id });
    expect((await h.db.select().from(personStats).where(eq(personStats.personId, p.id)))[0]).toMatchObject({ visits: 1, b2cStage: "first_visit" });
  });

  it("ops.daily_digest (the second run posts nothing)", async () => {
    await twice("ops.daily_digest", {});
    const posted = await h.db.select().from(jobsTable).where(eq(jobsTable.kind, "notify.slack"));
    expect(posted.filter((j) => (j.payload as { fingerprint?: string }).fingerprint === "digest")).toHaveLength(1);
  });
});

describe("ops.refresh_person_stats continuation (rule 5)", () => {
  it("chunks of 2,000 cover 4,500 persons and the recent refresh advances the cursor", async () => {
    await h.db.execute(sql`insert into persons (email, is_tester) select 'bulk-' || g || '@example.com', false from generate_series(1, 4500) g`);
    await h.db.execute(sql`delete from jobs where kind = 'ops.refresh_person_stats'`);
    const def = (await loadJobs())["ops.refresh_person_stats"]!;
    const runOn = "2026-11-05";
    let payload: Record<string, unknown> | null = { runOn };
    let runs = 0;
    while (payload) {
      const input = def.input.parse(payload);
      await h.db.transaction(async (tx) => {
        await def.run(makeJobCtx(h.db, "ops.refresh_person_stats", { tx }), input);
      });
      runs++;
      const pending = await h.db
        .select()
        .from(jobsTable)
        .where(and(eq(jobsTable.kind, "ops.refresh_person_stats"), eq(jobsTable.status, "pending")));
      const next = pending[0];
      if (next) {
        expect(next.idempotencyKey).toBe(nightlyKey(runOn, (next.payload as { afterId: string }).afterId));
        await h.db.update(jobsTable).set({ status: "succeeded" }).where(eq(jobsTable.id, next.id));
      }
      payload = (next?.payload as Record<string, unknown> | undefined) ?? null;
      if (runs > 10) throw new Error("continuation does not end");
    }
    const persons = (await h.db.execute(sql`select count(*)::int as n from persons where erased_at is null and merged_into_person_id is null`)) as unknown as {
      rows: { n: number }[];
    };
    const total = persons.rows[0]!.n;
    expect(total).toBeGreaterThanOrEqual(4_500);
    expect(runs).toBe(Math.ceil(total / NIGHTLY_CHUNK) + (total % NIGHTLY_CHUNK === 0 ? 1 : 0));
    const covered = (await h.db.execute(sql`select count(*)::int as n from person_stats`)) as unknown as { rows: { n: number }[] };
    expect(covered.rows[0]!.n).toBe(total);

    const before = (await h.db.execute(sql`select value->>'event_id' as id from ops_state where key = 'stats_cursor'`)) as unknown as { rows: { id: string }[] };
    const p = await makeCustomer(h.db);
    await h.db.execute(sql`insert into activity_events (person_id, kind, actor, data) values (${p.id}, 'booking.attended', '{"kind":"system","id":null}', '{}')`);
    await h.db.transaction(async (tx) => {
      const recent = (await loadJobs())["ops.refresh_recent_stats"]!;
      await recent.run(makeJobCtx(h.db, "ops.refresh_recent_stats", { tx }), {});
    });
    const after = (await h.db.execute(sql`select value->>'event_id' as id from ops_state where key = 'stats_cursor'`)) as unknown as { rows: { id: string }[] };
    expect(BigInt(after.rows[0]!.id)).toBeGreaterThan(BigInt(before.rows[0]?.id ?? "0"));
  }, 120_000);
});
