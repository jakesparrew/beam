/**
 * ops' own GDPR registration (ops spec 9; ops-P5): export, then erase, leaves no ops row that
 * references the person except `privacy_requests` (kept for accountability, export files gone).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { makeOrder } from "@beam/db/testing/commerce-factories";
import { setAppDb, sql } from "@/lib/ctx";
import { storeFile } from "@/lib/files";
import { rowsOf } from "@/lib/sensitive";
import { makeCtx, resetRuntime } from "@/lib/testing";
import { privacy } from "../privacy";
import { seedRequest } from "./ops-p5.fixtures";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const n = async (q: ReturnType<typeof sql>) => Number(rowsOf<{ n: number }>(await h.db.execute(q))[0]!.n);

async function seedOpsRows(personId: string) {
  const user = await makeUser(h.db);
  const { fileId } = await storeFile(makeCtx(h.db), { kind: "import", name: "persons.csv", mime: "text/csv", bytes: new TextEncoder().encode("email\nx@example.com\n") });
  const [imp] = rowsOf<{ id: string }>(
    await h.db.execute(sql`insert into imports (kind, source, name, file_id, created_by_user_id) values ('history', 'simplybook', 'History', ${fileId}::uuid, ${user.id}::uuid) returning id::text as id`),
  );
  const importId = imp!.id;
  await h.db.execute(sql`insert into person_stats (person_id) values (${personId}::uuid)`);
  await h.db.execute(sql`insert into import_rows (import_id, row_number, data, person_id) values (${importId}::uuid, 1, '{"email":"x"}'::jsonb, ${personId}::uuid)`);
  await h.db.execute(sql`insert into imported_history (person_id, import_id, source, kind, occurred_at, external_id, amount_cents, product_kind)
    values (${personId}::uuid, ${importId}::uuid, 'simplybook', 'purchase', now() - interval '400 days', ${`ext-${personId}`}, 4500, 'package')`);
  await h.db.execute(sql`insert into import_external_ids (source, entity_type, external_id, entity_id, import_id) values ('simplybook', 'person', ${`sb-${personId}`}, ${personId}::uuid, ${importId}::uuid)`);
  await h.db.execute(sql`insert into processing_restrictions (person_id, reason) values (${personId}::uuid, 'accuracy_contested')`);
  const [list] = rowsOf<{ id: string }>(
    await h.db.execute(sql`insert into retention_lists (week_start_on, size, thresholds, generated_at) values ('2026-11-02', 25, '{}'::jsonb, now()) returning id::text as id`),
  );
  await h.db.execute(sql`insert into retention_list_items (list_id, rank, person_id, score, primary_reason, reasons) values (${list!.id}::uuid, 1, ${personId}::uuid, 80, 'dormant', '{dormant}')`);
  const order = await makeOrder(h.db, { personId, status: "paid" });
  await h.db.execute(sql`insert into attribution_credits (order_id, person_id, model, campaign_key, weight, revenue_cents, paid_at, computed_at)
    values (${order.id}::uuid, ${personId}::uuid, 'first_touch', 'direct|none', 1, 4500, now(), now())`);
  const exportFile = await storeFile(makeCtx(h.db), { kind: "export", name: "privacy-export.zip.001.enc", mime: "application/octet-stream", bytes: new Uint8Array([1, 2, 3]), personId });
  await seedRequest(h.db, { personId, kind: "export", status: "done", fileId: exportFile.fileId });
  return { exportFileId: exportFile.fileId };
}

describe("ops privacy registration", () => {
  it("exports the subject's ops data, then erase leaves only privacy_requests (without export files)", async () => {
    const p = await makePerson(h.db);
    const other = await makePerson(h.db);
    await h.db.execute(sql`insert into person_stats (person_id) values (${other.id}::uuid)`);
    const { exportFileId } = await seedOpsRows(p.id);

    const data = await privacy.export(h.db as unknown as Tx, p.id);
    expect(Object.keys(data).sort()).toEqual(["imported_history", "person_stats", "privacy_requests", "processing_restrictions", "retention_list_items"]);
    expect(data.imported_history).toHaveLength(1);
    expect(data.privacy_requests).toHaveLength(1);
    expect(JSON.stringify(data)).not.toContain(other.id);

    let report: Awaited<ReturnType<typeof privacy.erase>> = [];
    await h.db.transaction(async (tx) => {
      await tx.execute(sql`set local beam.allow_rewrite = 'on'`);
      report = await privacy.erase(tx, p.id);
    });
    expect(report).toContainEqual({ table: "privacy_requests", rows: 1, action: "kept" });
    expect(report).toContainEqual({ table: "imported_history", rows: 1, action: "deleted" });

    for (const table of privacy.tables.filter((t) => t !== "privacy_requests" && t !== "nl_questions" && t !== "import_external_ids")) {
      expect(await n(sql`select count(*)::int as n from ${sql.raw(table)} where person_id = ${p.id}::uuid`), table).toBe(0);
    }
    expect(await n(sql`select count(*)::int as n from import_external_ids where entity_id = ${p.id}::uuid`)).toBe(0);
    expect(await n(sql`select count(*)::int as n from privacy_requests where person_id = ${p.id}::uuid and file_id is null`)).toBe(1);
    expect(await n(sql`select count(*)::int as n from files where id = ${exportFileId}::uuid`)).toBe(0);
    // Other people's rows stay.
    expect(await n(sql`select count(*)::int as n from person_stats where person_id = ${other.id}::uuid`)).toBe(1);
  });

  it("registers ops' sweep handlers (ops-P6's OPS_SWEEP) under their policy keys", () => {
    expect(Object.keys(privacy.sweep ?? {})).toEqual(
      expect.arrayContaining(["ops.import_rows", "ops.nl_questions", "ops.privacy_requests", "ops.data_exports", "ops.retention_lists", "ops.marketing_profile", "ops.marketing_contact"]),
    );
  });
});
