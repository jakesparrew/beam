/**
 * ops schema and defaults seed (ops-P1): the unique and partial unique constraints, the checks,
 * the append-only guard of `imported_history` and the idempotent seed, on a fresh PGlite
 * database built from the TypeScript schema.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CUTOVER_STEPS, DPIA_KEYS, RETENTION_DEFAULTS } from "@beam/core/ops";
import type { DbHandle } from "../client";
import { APPEND_ONLY_TABLES } from "./_shared";
import {
  OPS_APPEND_ONLY,
  adSpendDaily,
  cutoverChecklistItems,
  dataExports,
  dpiaRecords,
  importRows,
  importedHistory,
  imports,
  personStats,
  privacyRequests,
  processingRestrictions,
  retentionListItems,
  retentionLists,
  retentionPolicies,
} from "./ops";
import { files, settings } from "./platform";
import { createTestDb, makePerson, makeUser } from "../testing";
import { DEFAULT_SEEDS } from "../seed/index.generated";
import { OPS_RETENTION_POLICIES, insertRetentionPolicies, seed, seedOpsDefaults } from "../seed/ops";

/** The Postgres error behind a failed Drizzle query (message, SQLSTATE and constraint). */
async function pgError(promise: Promise<unknown>): Promise<{ message: string; code?: string; constraint?: string }> {
  try {
    await promise;
  } catch (error) {
    const cause =
      (error as { cause?: { message?: string; code?: string; constraint?: string } }).cause ??
      (error as { message?: string; code?: string; constraint?: string });
    return { message: String(cause.message ?? error), code: cause.code, constraint: cause.constraint };
  }
  throw new Error("expected the query to fail");
}

async function rejectsCheck(promise: Promise<unknown>, constraint: string) {
  const err = await pgError(promise);
  expect(err.code, err.message).toBe("23514");
  expect(`${err.constraint ?? ""} ${err.message}`).toContain(constraint);
}

async function rejectsUnique(promise: Promise<unknown>, constraint: string) {
  const err = await pgError(promise);
  expect(err.code, err.message).toBe("23505");
  expect(`${err.constraint ?? ""} ${err.message}`).toContain(constraint);
}

let h: DbHandle;
let userId: string;
let fileId: string;

beforeAll(async () => {
  h = await createTestDb();
  userId = (await makeUser(h.db)).id;
  const [file] = await h.db
    .insert(files)
    .values({ kind: "import", name: "clients.csv", mime: "text/csv", sizeBytes: 1, bytes: Buffer.from("a"), sha256: "0".repeat(64) })
    .returning();
  fileId = file!.id;
});
afterAll(() => h.close());

const newImport = (over: Partial<typeof imports.$inferInsert> = {}) =>
  h.db
    .insert(imports)
    .values({ kind: "persons", source: "simplybook", name: "SimplyBook clients", fileId, createdByUserId: userId, ...over })
    .returning();

const newRequest = (personId: string, over: Partial<typeof privacyRequests.$inferInsert> = {}) =>
  h.db
    .insert(privacyRequests)
    .values({ personId, kind: "erase", requestedBy: "customer", dueOn: "2026-12-04", ...over })
    .returning();

describe("privacy_requests", () => {
  it("allows one open request per person and kind", async () => {
    const p = await makePerson(h.db);
    await newRequest(p.id);
    await rejectsUnique(newRequest(p.id, { status: "verified" }), "privacy_requests_open_uq");
    // Another kind is fine.
    await newRequest(p.id, { kind: "export" });
  });

  it("allows a new request once the earlier one is done, failed or cancelled", async () => {
    const p = await makePerson(h.db);
    const [first] = await newRequest(p.id, { kind: "restrict" });
    await h.db.update(privacyRequests).set({ status: "done" }).where(eq(privacyRequests.id, first!.id));
    const [second] = await newRequest(p.id, { kind: "restrict" });
    await h.db.update(privacyRequests).set({ status: "cancelled" }).where(eq(privacyRequests.id, second!.id));
    const [third] = await newRequest(p.id, { kind: "restrict", status: "running" });
    expect(third!.runAttempt).toBe(1);
    expect(third!.rectifyFields).toEqual([]);
    expect(third!.warnings).toEqual([]);
  });

  it("limits the verification note to 500 characters", async () => {
    const p = await makePerson(h.db);
    await rejectsCheck(newRequest(p.id, { verificationNote: "x".repeat(501) }), "privacy_requests_note_ck");
  });

  it("keeps one restriction row per person with an article 18 reason", async () => {
    const p = await makePerson(h.db);
    await h.db.insert(processingRestrictions).values({ personId: p.id });
    await rejectsUnique(h.db.insert(processingRestrictions).values({ personId: p.id }), "processing_restrictions_person_uq");
    const q = await makePerson(h.db);
    await rejectsCheck(h.db.insert(processingRestrictions).values({ personId: q.id, reason: "because" }), "processing_restrictions_reason_ck");
  });
});

describe("imports", () => {
  it("needs both sign-off columns or neither", async () => {
    await rejectsCheck(newImport({ signedOffAt: new Date() }), "imports_sign_off_ck");
    await rejectsCheck(newImport({ signedOffByUserId: userId }), "imports_sign_off_ck");
    const [ok] = await newImport({ signedOffAt: new Date(), signedOffByUserId: userId });
    expect(ok!.status).toBe("uploaded");
    expect(ok!.isDryRun).toBe(true);
    expect(ok!.partFileIds).toEqual([]);
  });

  it("allows at most one running import (dry runs may overlap)", async () => {
    await newImport({ status: "dry_run" });
    await newImport({ status: "dry_run" });
    await newImport({ status: "running" });
    await rejectsUnique(newImport({ status: "running" }), "imports_one_running");
  });

  it("limits the name to 120 characters", async () => {
    await rejectsCheck(newImport({ name: "x".repeat(121) }), "imports_name_ck");
  });

  it("keeps row numbers unique per import and checks the entity type", async () => {
    const [imp] = await newImport();
    await h.db.insert(importRows).values({ importId: imp!.id, rowNumber: 1, data: { email: "a@example.com" } });
    await rejectsUnique(h.db.insert(importRows).values({ importId: imp!.id, rowNumber: 1, data: {} }), "import_rows_import_row_uq");
    await rejectsCheck(h.db.insert(importRows).values({ importId: imp!.id, rowNumber: 2, data: {}, entityType: "invoice" }), "import_rows_entity_type_ck");
  });
});

describe("imported_history (APPEND)", () => {
  it("is listed as append-only", () => {
    for (const t of OPS_APPEND_ONLY) expect(APPEND_ONLY_TABLES).toContain(t);
  });

  it("is unique per source, kind and external id and refuses updates and deletes", async () => {
    const p = await makePerson(h.db);
    const [imp] = await newImport({ kind: "history" });
    const values = { personId: p.id, importId: imp!.id, source: "simplybook" as const, kind: "visit" as const, occurredAt: new Date("2025-05-01T10:00:00Z"), externalId: "sb-1" };
    await h.db.insert(importedHistory).values(values);
    await rejectsUnique(h.db.insert(importedHistory).values(values), "imported_history_source_kind_external_uq");
    await rejectsCheck(h.db.insert(importedHistory).values({ ...values, externalId: "sb-2", productKind: "car" }), "imported_history_product_kind_ck");
    const err = await pgError(h.db.update(importedHistory).set({ description: "x" }).where(eq(importedHistory.externalId, "sb-1")));
    expect(err.message).toMatch(/append-only/);
    const del = await pgError(h.db.delete(importedHistory).where(eq(importedHistory.externalId, "sb-1")));
    expect(del.message).toMatch(/append-only/);
  });
});

describe("retention_policies", () => {
  const policy = (over: Partial<typeof retentionPolicies.$inferInsert>) =>
    h.db.insert(retentionPolicies).values({ key: "ops.test_policy", tableName: "t", days: 30, action: "delete", description: "test", ...over });

  it("ties keep to a null days value", async () => {
    await rejectsCheck(policy({ key: "ops.keep_with_days", action: "keep", days: 30 }), "retention_policies_days_ck");
    await rejectsCheck(policy({ key: "ops.delete_without_days", action: "delete", days: null }), "retention_policies_days_ck");
    await rejectsCheck(policy({ key: "ops.zero_days", days: 0 }), "retention_policies_days_ck");
    await policy({ key: "ops.keep_ok", action: "keep", days: null });
  });

  it("checks the key form <module>.<name>", async () => {
    await rejectsCheck(policy({ key: "marketing_profile" }), "retention_policies_key_ck");
    await rejectsCheck(policy({ key: "Ops.x" }), "retention_policies_key_ck");
    await rejectsCheck(policy({ key: "ops.1x" }), "retention_policies_key_ck");
    await policy({ key: "ops.marketing_profile_test" });
    await h.db.delete(retentionPolicies).where(eq(retentionPolicies.key, "ops.marketing_profile_test"));
    const accepted = await h.db.insert(retentionPolicies).values({ key: "ops.marketing_profile", tableName: "persons", days: 1095, action: "anonymise", description: "x" }).returning();
    expect(accepted[0]!.runOrder).toBe(100);
    expect(accepted[0]!.batchSize).toBe(1000);
    await h.db.delete(retentionPolicies).where(eq(retentionPolicies.key, "ops.marketing_profile"));
  });

  it("checks the last run status", async () => {
    await rejectsCheck(policy({ key: "ops.bad_status", lastRunStatus: "maybe" }), "retention_policies_status_ck");
  });
});

describe("other checks", () => {
  it("person_stats: one row per person, non-negative counts, probabilities between 0 and 1", async () => {
    const p = await makePerson(h.db);
    const [row] = await h.db.insert(personStats).values({ personId: p.id }).returning();
    expect(row!.b2cStage).toBe("lead");
    await rejectsUnique(h.db.insert(personStats).values({ personId: p.id }), "person_stats_person_uq");
    const q = await makePerson(h.db);
    await rejectsCheck(h.db.insert(personStats).values({ personId: q.id, purchases: -1 }), "person_stats_purchases_ck");
    await rejectsCheck(h.db.insert(personStats).values({ personId: q.id, churnProbability: "1.200" }), "person_stats_churn_ck");
  });

  it("data_exports: an entity exactly for entity exports, from the entity list", async () => {
    await rejectsCheck(h.db.insert(dataExports).values({ kind: "entity", createdByUserId: userId }), "data_exports_entity_ck");
    await rejectsCheck(h.db.insert(dataExports).values({ kind: "full", entity: "persons", createdByUserId: userId }), "data_exports_entity_ck");
    await rejectsCheck(h.db.insert(dataExports).values({ kind: "entity", entity: "password_hashes", createdByUserId: userId }), "data_exports_entity_list_ck");
    await h.db.insert(dataExports).values({ kind: "entity", entity: "persons", createdByUserId: userId });
    await h.db.insert(dataExports).values({ kind: "full", createdByUserId: userId });
  });

  it("retention_list_items: rank 1-100, unique rank and person per list", async () => {
    const [list] = await h.db.insert(retentionLists).values({ weekStartOn: "2026-11-02", size: 25, thresholds: {}, generatedAt: new Date() }).returning();
    const p = await makePerson(h.db);
    const item = { listId: list!.id, personId: p.id, score: 50, primaryReason: "visiting_less", reasons: ["visiting_less"] };
    await rejectsCheck(h.db.insert(retentionListItems).values({ ...item, rank: 0 }), "retention_list_items_rank_ck");
    await h.db.insert(retentionListItems).values({ ...item, rank: 1 });
    await rejectsUnique(h.db.insert(retentionListItems).values({ ...item, rank: 2 }), "retention_list_items_person_uq");
    const q = await makePerson(h.db);
    await rejectsUnique(h.db.insert(retentionListItems).values({ ...item, personId: q.id, rank: 1 }), "retention_list_items_rank_uq");
    await rejectsUnique(h.db.insert(retentionLists).values({ weekStartOn: "2026-11-02", size: 25, thresholds: {}, generatedAt: new Date() }), "retention_lists_week_uq");
  });

  it("ad_spend_daily: EUR only, non-negative amounts, one row per platform, campaign and day", async () => {
    const row = { platform: "meta" as const, accountId: "act_1", campaignExternalId: "c1", campaignName: "Spring", dayOn: "2026-11-01", spendCents: 1200, raw: {}, pulledAt: new Date() };
    await rejectsCheck(h.db.insert(adSpendDaily).values({ ...row, currency: "USD" }), "ad_spend_daily_currency_ck");
    await rejectsCheck(h.db.insert(adSpendDaily).values({ ...row, spendCents: -1 }), "ad_spend_daily_amounts_ck");
    await h.db.insert(adSpendDaily).values(row);
    await rejectsUnique(h.db.insert(adSpendDaily).values(row), "ad_spend_daily_uq");
  });
});

describe("ops defaults seed", () => {
  it("registers after platform and runs in DEFAULT_SEEDS", () => {
    expect(seed.after).toEqual(["platform"]);
    expect((DEFAULT_SEEDS as readonly { module: string }[]).map((s) => s.module)).toContain("ops");
  });

  it("seeds the retention policies, six DPIA rows, the retention_defaults setting and 17 cut-over steps", async () => {
    await h.db.delete(retentionPolicies);
    await seedOpsDefaults(h.db);
    const policies = await h.db.select().from(retentionPolicies);
    expect(policies.map((p) => p.key).sort()).toEqual(OPS_RETENTION_POLICIES.map((p) => p.key).sort());
    expect(OPS_RETENTION_POLICIES).toHaveLength(31);
    const profile = policies.find((p) => p.key === "ops.marketing_profile")!;
    expect(profile).toMatchObject({ days: 1095, action: "anonymise", runOrder: 11, tableName: "persons" });
    expect(policies.find((p) => p.key === "crm.suppressions")).toMatchObject({ days: null, action: "keep" });
    expect(policies.some((p) => p.key === "crm.inactive_profile")).toBe(false);

    const dpia = await h.db.select().from(dpiaRecords);
    expect(dpia.map((d) => d.key).sort()).toEqual([...DPIA_KEYS].sort());
    expect(dpia.every((d) => d.status === "not_started")).toBe(true);

    const [setting] = await h.db.select().from(settings).where(eq(settings.key, "retention_defaults"));
    expect(setting!.value).toEqual(RETENTION_DEFAULTS);

    const steps = await h.db.select().from(cutoverChecklistItems);
    expect(steps.map((s) => s.key).sort()).toEqual([...CUTOVER_STEPS].sort());
    expect(steps.every((s) => s.doneAt === null)).toBe(true);
  });

  it("is idempotent and never overwrites a staff edit", async () => {
    await h.db.update(retentionPolicies).set({ days: 2000 }).where(eq(retentionPolicies.key, "ops.marketing_profile"));
    await h.db.update(dpiaRecords).set({ status: "approved", decisionNote: "ok" }).where(eq(dpiaRecords.key, "voice_ai"));
    await h.db.update(settings).set({ value: { ...RETENTION_DEFAULTS, weekly_list_size: 30 } }).where(eq(settings.key, "retention_defaults"));
    await seedOpsDefaults(h.db);
    const [profile] = await h.db.select().from(retentionPolicies).where(eq(retentionPolicies.key, "ops.marketing_profile"));
    expect(profile!.days).toBe(2000);
    const [voice] = await h.db.select().from(dpiaRecords).where(and(eq(dpiaRecords.key, "voice_ai"), eq(dpiaRecords.status, "approved")));
    expect(voice).toBeDefined();
    const [setting] = await h.db.select().from(settings).where(eq(settings.key, "retention_defaults"));
    expect((setting!.value as { weekly_list_size: number }).weekly_list_size).toBe(30);
    expect(await h.db.select().from(retentionPolicies)).toHaveLength(OPS_RETENTION_POLICIES.length);
    expect(await h.db.select().from(cutoverChecklistItems)).toHaveLength(17);
  });

  it("insertRetentionPolicies adds a module's declared rows once", async () => {
    const extra = [{ key: "commerce.checkouts_test", tableName: "checkouts", days: 90, action: "delete" as const, description: "x", runOrder: 60 }];
    await insertRetentionPolicies(h.db, extra);
    await insertRetentionPolicies(h.db, extra);
    const rows = await h.db.select().from(retentionPolicies).where(eq(retentionPolicies.key, "commerce.checkouts_test"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.runOrder).toBe(60);
  });
});
