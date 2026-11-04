/**
 * ops's demo seed (runbook 6.3), run by `apps/web/scripts/seed-demo.ts` in `after` order. Facade
 * read by `pnpm gen:indexes`. Written once by ops-P1: it inserts every `retention` row a module
 * declares in its `privacy.ts` registration (`GDPR_REGISTRY`; commerce does this), because
 * `packages/db` may not import `apps/web` (ops spec 9, path a). Rows go in with
 * `on conflict (key) do nothing`, so a staff edit survives. ops's own rows, the DPIA register,
 * `retention_defaults` and the cut-over steps come from the defaults seed
 * (`packages/db/src/seed/ops.ts`), which runs first. Later ops packages add their demo rows
 * through their own area helpers.
 */
import type { PrivacyRegistration, RetentionPolicySeed } from "@beam/core/privacy";
import type { Tx } from "@beam/db";
import { insertRetentionPolicies } from "@beam/db/seed/ops";
import { GDPR_REGISTRY } from "@/registry/privacy.generated";
import type { SeedCtx } from "@/scripts/seed-demo";

/** Every module's declared retention rows, in module order. */
export function declaredRetentionSeeds(registry: Readonly<Record<string, PrivacyRegistration<Tx>>> = GDPR_REGISTRY): RetentionPolicySeed[] {
  return Object.entries(registry)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, reg]) => [...(reg.retention ?? [])]);
}

export async function runOpsDemoSeed(s: Pick<SeedCtx, "db">): Promise<{ policies: number }> {
  const rows = declaredRetentionSeeds();
  await insertRetentionPolicies(s.db, rows);
  return { policies: rows.length };
}

export const seed = { after: ["automation"], run: (s: SeedCtx) => runOpsDemoSeed(s) };
