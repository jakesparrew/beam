import { sql } from "drizzle-orm";
import { getDbHandle, type DatabaseDriver } from "./client";

export type DatabaseHealth = {
  ok: boolean;
  driver: DatabaseDriver;
  database?: string;
  serverVersion?: string;
  serverTime?: string;
  latencyMs: number;
  writeReadRoundTrip?: boolean;
  error?: string;
};

/**
 * Proves the database works end to end: connects, reads server metadata, and
 * writes then reads back a row inside one transaction that is rolled back, so
 * the check leaves no data behind.
 */
export async function checkDatabase(): Promise<DatabaseHealth> {
  const started = performance.now();
  const handle = getDbHandle();
  const elapsed = () => Math.round(performance.now() - started);
  const probe = `health-${Math.random().toString(36).slice(2)}`;

  try {
    if (handle.driver === "pg") {
      const client = await handle.pool.connect();
      try {
        const meta = await client.query<{ database: string; version: string; now: Date }>(
          "select current_database() as database, version() as version, now() as now",
        );
        await client.query("begin");
        await client.query("create temporary table beam_health_probe (value text not null) on commit drop");
        await client.query("insert into beam_health_probe (value) values ($1)", [probe]);
        const back = await client.query<{ value: string }>("select value from beam_health_probe");
        await client.query("rollback");
        const row = meta.rows[0];
        return {
          ok: back.rows[0]?.value === probe,
          driver: "pg",
          database: row?.database,
          serverVersion: row?.version.split(" ").slice(0, 2).join(" "),
          serverTime: row?.now.toISOString(),
          latencyMs: elapsed(),
          writeReadRoundTrip: back.rows[0]?.value === probe,
        };
      } finally {
        client.release();
      }
    }

    // neon-http: no interactive transactions, so the write/read probe runs as one
    // atomic batch (a single HTTP transaction) against a temporary table.
    const db = handle.db;
    const meta = await db.execute<{ database: string; version: string; now: string }>(
      sql`select current_database() as database, version() as version, now() as now`,
    );
    const [, , readBack] = await db.batch([
      db.execute(sql`create temporary table beam_health_probe (value text not null) on commit drop`),
      db.execute(sql`insert into beam_health_probe (value) values (${probe})`),
      db.execute<{ value: string }>(sql`select value from beam_health_probe`),
    ]);
    const row = meta.rows[0];
    const roundTrip = readBack.rows[0]?.value === probe;
    return {
      ok: roundTrip,
      driver: "neon-http",
      database: row?.database,
      serverVersion: row?.version.split(" ").slice(0, 2).join(" "),
      serverTime: row ? new Date(row.now).toISOString() : undefined,
      latencyMs: elapsed(),
      writeReadRoundTrip: roundTrip,
    };
  } catch (error) {
    return {
      ok: false,
      driver: handle.driver,
      latencyMs: elapsed(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
