/**
 * booking's demo seed (runbook 6.3, booking-P2), run by `apps/web/scripts/seed-demo.ts` in
 * `after` order. Facade read by `pnpm gen:indexes`. Writes the demo schedule and the demo
 * lecture (`seedBookingDemo` in `@beam/db/seed/booking`) and materialises the next 90 days, so
 * a seeded `beam_dev` shows sessions in `/admin/sessions`. Idempotent.
 */
import { MATERIALISE_DAYS, addDays, brusselsDate } from "@beam/core/booking";
import { seedBookingDefaults, seedBookingDemo } from "@beam/db/seed/booking";
import type { SeedCtx } from "@/scripts/seed-demo";
import { materialiseRange } from "./jobs/schedule";

export async function runBookingDemoSeed(s: SeedCtx): Promise<{ templates: number; inserted: number }> {
  await seedBookingDefaults(s.db);
  const { templateIds } = await seedBookingDemo(s.db, { now: s.now });
  const today = brusselsDate(s.now);
  const { inserted } = await materialiseRange(s.db, today, addDays(today, MATERIALISE_DAYS), { notBefore: s.now, now: s.now });
  return { templates: templateIds.length, inserted };
}

export const seed = { after: ["credits"], run: (s: SeedCtx) => runBookingDemoSeed(s) };
