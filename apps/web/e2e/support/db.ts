import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { createDbHandle, type Db, type DbHandle } from "@beam/db";

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: [path.join(here, "../../../../.env.local"), path.join(here, "../../../../.env")], quiet: true });

let handle: Promise<DbHandle> | undefined;

/**
 * A `@beam/db` handle over `neon-ws` for what the UI does not show (sink emails, audit rows).
 * One per worker; call `closeE2eDb()` in `afterAll`. Specs never write demo seed rows.
 */
export async function e2eDb(): Promise<Db> {
  handle ??= createDbHandle(process.env.DATABASE_DRIVER === "pg" ? "pg" : "neon-ws");
  return (await handle).db;
}

export async function closeE2eDb(): Promise<void> {
  if (!handle) return;
  const h = handle;
  handle = undefined;
  await (await h).close();
}

/** Rows of a raw query (node-postgres and the Neon pool both return `{ rows }`). */
export async function e2eRows<T>(query: Parameters<Db["execute"]>[0]): Promise<T[]> {
  const result: unknown = await (await e2eDb()).execute(query);
  return ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
}

/**
 * Runs `queries` in one transaction under `beam.allow_rewrite`, the way the erasure and retention
 * jobs delete: append-only tables (`email_events`, ...) refuse a plain DELETE, also by cascade.
 */
export async function e2eRewrite(queries: Parameters<Db["execute"]>[0][]): Promise<void> {
  const db = await e2eDb();
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local beam.allow_rewrite = 'on'`);
    for (const q of queries) await tx.execute(q);
  });
}

/** A Postgres array literal for a `::uuid[]` parameter (a JS array would expand to `($1, $2)`). */
export const pgArray = (values: readonly string[] | null | undefined): string => `{${(values ?? []).join(",")}}`;

/**
 * PL-68 allows 20 public-form API calls (view, start, save, submit) per IP per minute; the whole
 * suite runs from one IP on two workers, so a form-heavy spec clears the bucket before each test.
 * The limit itself is covered by `lib/rate-limit.test.ts`.
 */
export async function clearPublicFormLimit(): Promise<void> {
  await e2eRows(sql`delete from rate_limits where key like 'forms:ip:%'`);
}
