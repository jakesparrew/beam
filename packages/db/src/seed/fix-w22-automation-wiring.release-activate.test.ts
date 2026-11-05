/**
 * The go-live command of the R2/R3 switch-over (fix-w22-automation-wiring, N-1 of
 * docs/build/seam-issues-r2.md): `parseActivationRelease`, `formatActivationReport`,
 * `runReleaseActivation` on a seeded database (one transaction, idempotent, DPIA-gated journeys
 * reported), and `releaseActivationCli` refusing an unknown release before it connects.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { seedsOfRelease } from "@beam/core/automation/seeds";
import type { DbHandle } from "../client";
import { automations } from "../schema/automation";
import { auditLog } from "../schema/platform";
import { createTestDb } from "../testing";
import { formatActivationReport, parseActivationRelease, releaseActivationCli, runReleaseActivation } from "./automation";
import { seedDefaults } from "./run";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  await seedDefaults(h.db);
});
afterAll(async () => {
  await h.close();
});

describe("release activation command", () => {
  it("parses R2 and R3 in any case and refuses anything else", () => {
    expect(parseActivationRelease("R2")).toBe("R2");
    expect(parseActivationRelease(" r3 ")).toBe("R3");
    expect(() => parseActivationRelease("V1")).toThrow(/R2, R3/);
    expect(() => parseActivationRelease(undefined)).toThrow(/R2, R3/);
  });

  it("formats what was activated and what a DPIA blocks", () => {
    expect(formatActivationReport("R2", { activated: ["a", "b"], blocked: ["c:marketing_profiling"] })).toEqual([
      "R2: 2 journey(s) activated: a, b",
      "R2: c stays draft until DPIA marketing_profiling is approved",
    ]);
    expect(formatActivationReport("R3", { activated: [], blocked: [] })).toEqual(["R3: 0 journey(s) activated"]);
  });

  it("switches on the seeded drafts of the release once, audited, and reports DPIA-blocked ones", async () => {
    const slugs = seedsOfRelease("R2").map((s) => s.slug);
    const gated = seedsOfRelease("R2").filter((s) => s.requiresDpia);
    const lines: string[] = [];
    const first = await runReleaseActivation(h.db, "R2", { isDpiaApproved: async () => false, log: (l) => lines.push(l) });
    expect(first.activated.length).toBe(slugs.length - gated.length);
    expect(first.blocked).toEqual(gated.map((s) => `${s.slug}:${s.requiresDpia}`));
    expect(lines).toEqual(formatActivationReport("R2", first));
    const active = await h.db
      .select({ slug: automations.slug })
      .from(automations)
      .where(and(inArray(automations.slug, slugs), eq(automations.status, "active")));
    expect(active.map((r) => r.slug).sort()).toEqual([...first.activated].sort());
    const audits = await h.db.select().from(auditLog).where(eq(auditLog.action, "automation.activate"));
    expect(audits).toHaveLength(first.activated.length);

    // A second run activates nothing new; an approved DPIA then releases the gated journeys.
    const second = await runReleaseActivation(h.db, "R2", { isDpiaApproved: async () => false, log: () => undefined });
    expect(second.activated).toEqual([]);
    const third = await runReleaseActivation(h.db, "R2", { isDpiaApproved: async () => true, log: () => undefined });
    expect(third).toEqual({ activated: gated.map((s) => s.slug), blocked: [] });
  });

  it("the command line refuses an unknown release before it connects", async () => {
    const lines: string[] = [];
    expect(await releaseActivationCli(["R9"], (l) => lines.push(l))).toBe(1);
    expect(lines[0]).toMatch(/^release:activate: release must be one of R2, R3/);
  });
});
