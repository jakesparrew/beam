/**
 * email's seed (runbook 6.3, email spec sections 8 and 15a), run by
 * `apps/web/scripts/seed-demo.ts` in `after` order. Facade read by `pnpm gen:indexes`.
 *
 * `seedSystemTemplates(db)` creates one `email_templates` row (`kind = transactional`,
 * `is_system = true`) and a published version 1 per `TEMPLATE_REGISTRY` entry, with copy from the
 * owning module's catalogue (`<m>.email.<name>.<slot>`). An existing slug is never touched, so
 * copy edited by staff survives every reseed and later catalogue changes never overwrite it. The
 * retention rows come from the `defaults` profile (`packages/db/src/seed/email.ts`). The same
 * function is safe to run in production (no demo data).
 */
import type { DbOrTx } from "@beam/db";
import type { SeedCtx } from "@/scripts/seed-demo";
import { ensureSystemTemplate, registryKeys } from "./server/templates-info";

export async function seedSystemTemplates(db: DbOrTx): Promise<{ created: string[]; existing: string[] }> {
  const created: string[] = [];
  const existing: string[] = [];
  for (const key of registryKeys()) {
    const result = await ensureSystemTemplate(db, key);
    if (!result) continue;
    (result.created ? created : existing).push(key);
  }
  return { created, existing };
}

export const seed = { after: ["finance"], run: (s: SeedCtx) => seedSystemTemplates(s.db) };
