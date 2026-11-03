import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
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
