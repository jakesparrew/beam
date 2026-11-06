import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema/index";

/**
 * Database access for the whole platform.
 *
 * All code uses one type, `Db`, and may rely on interactive transactions
 * (`db.transaction(async (tx) => ...)`) and row locks (`for update`).
 * The driver is chosen by DATABASE_DRIVER:
 *
 * - "pg" (default): node-postgres pool over TCP. Recommended by Neon for
 *   Vercel Fluid compute; `attachDatabasePool` lets Vercel close idle
 *   connections before an instance is suspended.
 * - "neon-ws": Neon's serverless Pool over WebSockets (port 443). Same
 *   semantics as "pg". Used where TCP 5432 is blocked (cloud sandbox, CI).
 * - "pglite": PostgreSQL 18 in-process (tests only; see `@beam/db/testing`).
 */
export type DatabaseDriver = "pg" | "neon-ws" | "pglite";
export type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema>;
/** The transaction handle passed to `db.transaction` callbacks. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything that can run queries: the database or an open transaction. */
export type DbOrTx = Db | Tx;

export type DbHandle = {
  driver: DatabaseDriver;
  db: Db;
  close: () => Promise<void>;
};

export function resolveDriver(): DatabaseDriver {
  const value = process.env.DATABASE_DRIVER ?? "pg";
  if (value !== "pg" && value !== "neon-ws" && value !== "pglite") {
    throw new Error(`DATABASE_DRIVER must be "pg", "neon-ws" or "pglite", got "${value}"`);
  }
  return value;
}

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
  return url;
}

/**
 * Keeps the process alive when the pool reports an error on an idle connection (a dropped socket,
 * a Neon compute restart): node-postgres and the Neon pool emit `error` on the pool, and an
 * unhandled `error` event exits Node. The pool discards that client and opens a new one on the
 * next query, so logging is enough (found by the load test on beam_dev).
 */
export function watchPool(pool: { on(event: "error", listener: (err: Error) => void): unknown }, driver: string): void {
  pool.on("error", (err) => {
    process.stderr.write(`[db] ${driver} pool: idle connection error: ${err.message}\n`);
  });
}

async function createPgHandle(url: string): Promise<DbHandle> {
  const [{ Pool }, { drizzle }, { attachDatabasePool }] = await Promise.all([
    import("pg"),
    import("drizzle-orm/node-postgres"),
    import("@vercel/functions"),
  ]);
  const pool = new Pool({ connectionString: url, max: 10, idleTimeoutMillis: 10_000 });
  watchPool(pool, "pg");
  attachDatabasePool(pool);
  const db = drizzle({ client: pool, schema, casing: "snake_case" }) as unknown as Db;
  return { driver: "pg", db, close: () => pool.end() };
}

async function createNeonWsHandle(url: string): Promise<DbHandle> {
  const [{ Pool, neonConfig }, { drizzle }] = await Promise.all([
    import("@neondatabase/serverless"),
    import("drizzle-orm/neon-serverless"),
  ]);
  // Node 22+ ships a global WebSocket (it honours NODE_USE_ENV_PROXY=1 for the sandbox proxy).
  neonConfig.webSocketConstructor = globalThis.WebSocket;
  const pool = new Pool({ connectionString: url, max: 10 });
  watchPool(pool, "neon-ws");
  const db = drizzle({ client: pool, schema, casing: "snake_case" }) as unknown as Db;
  return { driver: "neon-ws", db, close: () => pool.end() };
}

export async function createDbHandle(driver: DatabaseDriver = resolveDriver(), url?: string): Promise<DbHandle> {
  if (driver === "pglite") {
    throw new Error('DATABASE_DRIVER="pglite" is for tests: use createTestDb() from "@beam/db/testing".');
  }
  const connectionString = url ?? requireDatabaseUrl();
  return driver === "neon-ws" ? createNeonWsHandle(connectionString) : createPgHandle(connectionString);
}

// One handle per server instance, reused across requests and hot reloads.
const globalForDb = globalThis as unknown as { __beamDb?: Promise<DbHandle> };

export function getDbHandle(): Promise<DbHandle> {
  globalForDb.__beamDb ??= createDbHandle();
  return globalForDb.__beamDb;
}

export async function getDb(): Promise<Db> {
  return (await getDbHandle()).db;
}
