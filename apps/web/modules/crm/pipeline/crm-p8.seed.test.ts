/**
 * crm-P8 seed: the `defaults` profile writes the default sales playbook (13 B2B stages, one per
 * `opportunities_stage` value, and 10 B2C stages, one per ops `b2c_stage` value) with complete
 * texts in the three locales, and a re-run changes nothing (staff edits survive).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { OPPORTUNITY_STAGES, playbookStages } from "@beam/db/schema";
import { seed } from "@beam/db/seed/crm";
import { B2C_STAGES } from "@beam/core/ops";
import { and, asc, eq } from "@/lib/ctx";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
});

describe("crm-P8 default playbook seed", () => {
  it("seeds 13 B2B and 10 B2C stages in order with complete texts, idempotently", async () => {
    await seed.run(h.db, {});
    await h.db.update(playbookStages).set({ deadlineDays: 9 }).where(and(eq(playbookStages.pipeline, "b2b"), eq(playbookStages.stageKey, "proposal")));
    await seed.run(h.db, {});
    const rows = await h.db.select().from(playbookStages).orderBy(asc(playbookStages.pipeline), asc(playbookStages.sortOrder));
    const b2b = rows.filter((r) => r.pipeline === "b2b");
    const b2c = rows.filter((r) => r.pipeline === "b2c");
    expect(b2b.map((r) => r.stageKey)).toEqual([...OPPORTUNITY_STAGES]);
    expect(b2c.map((r) => r.stageKey)).toEqual([...B2C_STAGES]);
    for (const r of rows) {
      for (const text of [r.name, r.requiredAction]) expect(Object.keys(text).sort()).toEqual(["en", "fr-BE", "nl-BE"]);
      expect(r.isActive).toBe(true);
    }
    expect(b2c.every((r) => r.defaultProbabilityPct === null)).toBe(true);
    expect(b2b.find((r) => r.stageKey === "won")!.defaultProbabilityPct).toBe(100);
    expect(b2b.find((r) => r.stageKey === "proposal")!.deadlineDays).toBe(9);
  });
});
