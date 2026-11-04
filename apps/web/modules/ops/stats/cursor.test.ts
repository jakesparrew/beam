/**
 * ops rule 6: `ops.refresh_recent_stats` and `ops_state.stats_cursor`. PGlite has one
 * connection, so a second session holding the cursor row is simulated at the SQL boundary: the
 * job's `for update skip locked` read returns no row, exactly what Postgres answers while a
 * slower run holds the lock. The cursor never moves backwards, also when a later run advanced it
 * while this one was computing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DbHandle, Tx } from "@beam/db";
import { personStats } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import { eq, sql, type SQL } from "@/lib/ctx";
import { makeJobCtx, resetRuntime } from "@/lib/testing";
import { RECENT_LIMIT, runRefreshRecentStats } from "./jobs";
import { makeCustomer } from "./ops-p2.fixtures";

let h: DbHandle;
const dialect = new PgDialect();
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  await h.db.execute(sql`delete from ops_state where key = 'stats_cursor'`);
});

const cursor = async (): Promise<string | null> => {
  const r = (await h.db.execute(sql`select value->>'event_id' as id from ops_state where key = 'stats_cursor'`)) as unknown as { rows: { id: string }[] };
  return r.rows[0]?.id ?? null;
};
const maxEventId = async (): Promise<string> => {
  const r = (await h.db.execute(sql`select max(id)::text as id from activity_events`)) as unknown as { rows: { id: string }[] };
  return r.rows[0]!.id;
};
const event = (personId: string, kind = "booking.attended") =>
  h.db.execute(sql`insert into activity_events (person_id, kind, actor, data) values (${personId}, ${kind}, '{"kind":"system","id":null}', '{}')`);

/** The test database seen through a hook on raw statements (`execute`). */
function hookedTx(hook: (text: string) => Promise<unknown> | undefined): Tx {
  const target = h.db as unknown as Record<string | symbol, unknown>;
  return new Proxy(target, {
    get(t, prop) {
      if (prop === "execute") {
        return async (q: SQL) => {
          const text = dialect.sqlToQuery(q).sql;
          const replaced = await hook(text);
          return replaced ?? (h.db.execute(q));
        };
      }
      const v = Reflect.get(t, prop);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as Tx;
}

const run = (tx?: Tx) => runRefreshRecentStats(makeJobCtx(h.db, "ops.refresh_recent_stats", tx ? { tx } : {}), {});

describe("ops.refresh_recent_stats cursor (rule 6)", () => {
  it("R6 a second run exits at once while the first holds the stats_cursor lock", async () => {
    const p = await makeCustomer(h.db);
    await event(p.id);
    const locked = hookedTx((text) => (/for update skip locked/i.test(text) ? Promise.resolve({ rows: [] }) : undefined));
    expect(await run(locked)).toEqual({ skipped: "locked" });
    expect(await h.db.select().from(personStats).where(eq(personStats.personId, p.id))).toEqual([]);
    expect(await cursor()).toBe("0");
  });

  it("R6 recomputes the people with a STATS_KINDS event after the cursor and advances it", async () => {
    const p = await makeCustomer(h.db);
    const other = await makeCustomer(h.db);
    await event(p.id, "credits.consumed");
    await event(other.id, "crm.note_added");
    const result = (await run()) as { persons: number; cursor: string };
    expect(await cursor()).toBe(result.cursor);
    expect(BigInt(result.cursor)).toBeGreaterThan(0n);
    expect(await h.db.select().from(personStats).where(eq(personStats.personId, p.id))).toHaveLength(1);
    expect(await h.db.select().from(personStats).where(eq(personStats.personId, other.id))).toEqual([]);
    // Nothing new: the cursor stays.
    expect(await run()).toMatchObject({ persons: 0, cursor: result.cursor });
  });

  it("R6 the cursor never moves backwards when a later run advanced it meanwhile", async () => {
    const p = await makeCustomer(h.db);
    await event(p.id, "order.paid");
    await h.db.execute(sql`insert into ops_state (key, value) values ('stats_cursor', '{"event_id":"0"}')`);
    const ahead = "999999999";
    const racing = hookedTx((text) => {
      if (/min\(a\.id\) as first_id/i.test(text)) {
        return h.db.execute(sql`update ops_state set value = ${JSON.stringify({ event_id: ahead })}::jsonb where key = 'stats_cursor'`).then(() => undefined);
      }
      return undefined;
    });
    await run(racing);
    expect(await cursor()).toBe(ahead);
  });

  it("R6 at most 1,000 people per run; the next run takes the rest and the cursor ends at the last event", async () => {
    const res = (await h.db.execute(sql`insert into persons (email, is_tester) select 'recent-' || g || '@example.com', false
      from generate_series(1, ${RECENT_LIMIT + 5}) g returning id`)) as unknown as { rows: { id: string }[] };
    await h.db.execute(sql`insert into activity_events (person_id, kind, actor, data)
      select id, 'booking.confirmed', '{"kind":"system","id":null}', '{}' from persons where email like 'recent-%@example.com' order by email`);
    const first = (await run()) as { persons: number; cursor: string };
    expect(first.persons).toBe(RECENT_LIMIT);
    const second = (await run()) as { persons: number; cursor: string };
    expect(second.persons).toBeGreaterThanOrEqual(5);
    expect(BigInt(second.cursor)).toBeGreaterThan(BigInt(first.cursor));
    expect(second.cursor).toBe(await maxEventId());
    const covered = (await h.db.execute(sql`select count(*)::int as n from person_stats ps join persons p on p.id = ps.person_id
      where p.email like 'recent-%@example.com'`)) as unknown as { rows: { n: number }[] };
    expect(covered.rows[0]!.n).toBe(res.rows.length);
  });
});
