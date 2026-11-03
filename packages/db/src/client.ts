import { neon } from "@neondatabase/serverless";
import { attachDatabasePool } from "@vercel/functions";
import { drizzle as drizzleNeonHttp } from "drizzle-orm/neon-http";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index";

/**
 * Database driver selection.
 *
 * - "pg" (default): node-postgres over TCP with a connection pool. This is the
 *   recommended driver on Vercel with Fluid compute; `attachDatabasePool` lets
 *   Vercel close idle connections before a function instance is suspended.
 * - "neon-http": Neon's serverless driver over HTTPS (port 443). Used where TCP
 *   port 5432 is not reachable, such as the cloud build sandbox and CI. It does
 *   not support interactive transactions; use `db.batch` for atomic writes there.
 */
export type DatabaseDriver = "pg" | "neon-http";

export function resolveDriver(): DatabaseDriver {
  const value = process.env.DATABASE_DRIVER ?? "pg";
  if (value !== "pg" && value !== "neon-http") {
    throw new Error(`DATABASE_DRIVER must be "pg" or "neon-http", got "${value}"`);
  }
  return value;
}

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
  return url;
}

function createPgDb(url: string) {
  const pool = new Pool({ connectionString: url, max: 10, idleTimeoutMillis: 10_000 });
  attachDatabasePool(pool);
  return { driver: "pg" as const, pool, db: drizzleNodePg({ client: pool, schema, casing: "snake_case" }) };
}

function createNeonHttpDb(url: string) {
  return { driver: "neon-http" as const, pool: null, db: drizzleNeonHttp({ client: neon(url), schema, casing: "snake_case" }) };
}

type DbHandle = ReturnType<typeof createPgDb> | ReturnType<typeof createNeonHttpDb>;

// One handle per server instance, reused across requests (and across hot reloads in dev).
const globalForDb = globalThis as unknown as { __beamDb?: DbHandle };

export function getDbHandle(): DbHandle {
  if (!globalForDb.__beamDb) {
    const url = requireDatabaseUrl();
    globalForDb.__beamDb = resolveDriver() === "neon-http" ? createNeonHttpDb(url) : createPgDb(url);
  }
  return globalForDb.__beamDb;
}

export function getDb() {
  return getDbHandle().db;
}
