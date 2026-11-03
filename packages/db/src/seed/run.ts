/**
 * The `defaults` seed profile (runbook 3.4, BS-11). Every module's
 * `packages/db/src/seed/<m>.ts` exports `seed = { after?, run(db, options) }`; `gen:indexes`
 * orders them into `DEFAULT_SEEDS`. Every run is idempotent.
 */
import type { DbOrTx } from "../client";
import { DEFAULT_SEEDS } from "./index.generated";

export type SeedOptions = {
  /**
   * The permission registry (`PERMISSIONS` of `apps/web/registry/permissions.generated.ts`).
   * `@beam/db` never imports `apps/web`, so the caller passes it; role grants are computed from
   * it (platform spec section 7). Without it the V1 permission list of architecture section 4
   * is used.
   */
  permissions?: readonly string[];
};

/** The shape of a `packages/db/src/seed/<m>.ts` `seed` export. */
export type DefaultSeed = {
  after?: readonly string[];
  run: (db: DbOrTx, options: SeedOptions) => Promise<void>;
};

type SeedRow = {
  module: string;
  after: readonly string[];
  run: DefaultSeed["run"];
};

/** A database that can open transactions (the `Db`, or a transaction for nested savepoints). */
type TransactionalDb = Pick<DbOrTx, "transaction">;

/** Runs `DEFAULT_SEEDS` in dependency order, one transaction per module. Returns the modules run. */
export async function seedDefaults(
  db: TransactionalDb,
  options: SeedOptions = {},
): Promise<string[]> {
  const ran: string[] = [];
  for (const s of DEFAULT_SEEDS as readonly SeedRow[]) {
    await db.transaction(async (tx) => {
      await s.run(tx, options);
    });
    ran.push(s.module);
  }
  return ran;
}

export { grantDefaultPermission } from "./platform";
