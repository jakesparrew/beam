import { sql } from "drizzle-orm";
import { getDbHandle, type DatabaseDriver, type DbHandle } from "./client";

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

type MetaRow = { database: string; version: string; now: string | Date };
type ProbeRow = { value: string };

function rowsOf<T>(result: unknown): T[] {
  // node-postgres and Neon return { rows }, PGlite returns { rows } as well; guard anyway.
  if (result && typeof result === "object" && "rows" in result) return (result as { rows: T[] }).rows;
  return result as T[];
}

/**
 * Proves the database works end to end: connects, reads server metadata, and
 * writes then reads back a row inside a transaction that is rolled back, so
 * the check leaves no data behind.
 */
export async function checkDatabase(handle?: DbHandle): Promise<DatabaseHealth> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  let driver: DatabaseDriver = "pg";
  try {
    const h = handle ?? (await getDbHandle());
    driver = h.driver;
    const probe = `health-${Math.random().toString(36).slice(2)}`;
    const meta = rowsOf<MetaRow>(
      await h.db.execute(sql`select current_database() as database, version() as version, now() as now`),
    )[0];

    let readBack: string | undefined;
    const rollback = new Error("rollback health probe");
    try {
      await h.db.transaction(async (tx) => {
        await tx.execute(sql`create temporary table beam_health_probe (value text not null) on commit drop`);
        await tx.execute(sql`insert into beam_health_probe (value) values (${probe})`);
        readBack = rowsOf<ProbeRow>(await tx.execute(sql`select value from beam_health_probe`))[0]?.value;
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }

    const roundTrip = readBack === probe;
    return {
      ok: roundTrip,
      driver,
      database: meta?.database,
      serverVersion: meta?.version.split(" ").slice(0, 2).join(" "),
      serverTime: meta ? new Date(meta.now).toISOString() : undefined,
      latencyMs: elapsed(),
      writeReadRoundTrip: roundTrip,
    };
  } catch (error) {
    return {
      ok: false,
      driver,
      latencyMs: elapsed(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
