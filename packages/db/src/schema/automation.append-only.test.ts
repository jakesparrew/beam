/**
 * automation append-only facts (automation-P1, section 2.4 and 2.6), on a database built from the
 * committed migrations: update and delete on `automation_runs` and `automation_versions` are
 * rejected by `reject_update_delete()`, and allowed under `SET LOCAL beam.allow_rewrite = 'on'`.
 *
 * Skipped with a message until the wave's migration (tables plus `w<NN>_protect`) exists; the
 * wave gate runs it after the orchestrator generated the migration.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../client";
import { committedMigrationSql, createTestDb, makePerson } from "../testing";
import { automationGroups, automationRuns, automations, automationVersions } from "./automation";

const migrations = committedMigrationSql().join("\n");
const hasTables = /create table "automation_runs"/i.test(migrations) && /create table "automation_versions"/i.test(migrations);
const hasProtect = /beam_protect_append_only\(\)/.test(migrations.split(/create table "automation_runs"/i)[1] ?? "");
const ready = hasTables && hasProtect;
const SKIP_MESSAGE =
  "skipped: the committed migrations do not yet create and protect automation_runs and automation_versions; " +
  "the wave gate runs this file after the orchestrator generates the wave migration";

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;
  }
  return undefined;
}

describe.skipIf(!ready)("automation append-only tables (from migrations)", () => {
  let h: DbHandle;
  let versionId: string;
  let runId: string;

  beforeAll(async () => {
    h = await createTestDb({ from: "migrations" });
    const [g] = await h.db.insert(automationGroups).values({ key: "append_only", name: "Append only" }).returning();
    const [a] = await h.db.insert(automations).values({ slug: "append-only", name: "Append only", groupId: g!.id, isMarketing: false }).returning();
    const [v] = await h.db
      .insert(automationVersions)
      .values({ automationId: a!.id, version: 1, definition: {}, definitionHash: "hash" })
      .returning();
    const person = await makePerson(h.db);
    const [r] = await h.db
      .insert(automationRuns)
      .values({ personId: person.id, automationId: a!.id, automationVersionId: v!.id, outcome: "entered", actor: { kind: "job", id: null } })
      .returning();
    versionId = v!.id;
    runId = r!.id;
  });
  afterAll(() => h?.close());

  it("rejects update and delete on automation_runs", async () => {
    expect(await sqlState(h.db.update(automationRuns).set({ reason: "x" }).where(eq(automationRuns.id, runId)))).toBe("55000");
    expect(await sqlState(h.db.delete(automationRuns).where(eq(automationRuns.id, runId)))).toBe("55000");
  });

  it("rejects update and delete on automation_versions", async () => {
    expect(await sqlState(h.db.update(automationVersions).set({ changeNote: "x" }).where(eq(automationVersions.id, versionId)))).toBe("55000");
    expect(await sqlState(h.db.delete(automationVersions).where(eq(automationVersions.id, versionId)))).toBe("55000");
  });

  it("allows both under SET LOCAL beam.allow_rewrite = 'on' (erasure and retention)", async () => {
    await h.db.transaction(async (tx) => {
      await tx.execute(sql`set local beam.allow_rewrite = 'on'`);
      await tx.update(automationRuns).set({ reason: "rewritten" }).where(eq(automationRuns.id, runId));
      await tx.delete(automationRuns).where(eq(automationRuns.id, runId));
      await tx.update(automationVersions).set({ changeNote: "rewritten" }).where(eq(automationVersions.id, versionId));
    });
    expect(await h.db.select().from(automationRuns).where(eq(automationRuns.id, runId))).toHaveLength(0);
  });
});

describe.runIf(!ready)("automation append-only tables (waiting for the wave migration)", () => {
  it(SKIP_MESSAGE, () => {
    expect(ready).toBe(false);
  });
});
