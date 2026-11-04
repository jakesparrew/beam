/**
 * automation's demo seed (runbook 6.3), run by `apps/web/scripts/seed-demo.ts` in `after` order.
 * Facade read by `pnpm gen:indexes`. The seeded groups, tags, templates and journeys of spec 3.6
 * (automation-P4) are system rows the `defaults` profile already writes; this run makes sure they
 * exist on a demo database and reports what it created (zero counts on a reseed). No demo
 * enrolments: journeys fill from the demo activity the job runner processes.
 */
import type { Tx } from "@beam/db";
import type { SeedCtx } from "@/scripts/seed-demo";
import { seedAutomation } from "./engine/seed-automations";

export const seed = { after: ["email"], run: (s: SeedCtx) => seedAutomation(s.db as Tx) };
