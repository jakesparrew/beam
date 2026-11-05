/**
 * ops-P10: the `ai` schema of `0101_ai_views_ops.sql` on PGlite, after platform's `0100`, read
 * through platform's `runAiReadOnlyQuery` as `beam_ai_ro` (ops spec 2.4, rule 77).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Db, DbHandle } from "@beam/db";
import { persons, SENSITIVE_COLUMNS } from "@beam/db/schema";
import { applyCustomSql, createTestDb, makePerson } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { SENSITIVE_FIELD_KEYS } from "@beam/core/privacy";
import { WEBINAR_PERFORMANCE_DAILY_COLUMNS } from "@beam/db/schema";
import { eq } from "@/lib/ctx";
import { makeJobCtx } from "@/lib/testing";
import { rowsOf } from "@/lib/sensitive";
import { runAiReadOnlyQuery } from "@/modules/platform/api";
import { AI_VIEWS } from "@beam/core/ops";

let handle: DbHandle;
let db: Db;
let lotte: { id: string };
let restricted: { id: string };

const q = async <T>(text: string) => rowsOf<T>(await db.execute(sql.raw(text)));
const ctx = () => makeJobCtx(db, "ai.answer_question");

beforeAll(async () => {
  handle = await createTestDb();
  db = handle.db;
  await applyCustomSql(handle, { files: ["0100_ai_readonly.sql", "0101_ai_views_ops.sql"] });
  // Idempotent: the custom migration and the tests may both run it.
  await applyCustomSql(handle, { files: ["0101_ai_views_ops.sql"] });
  lotte = await makePerson(db, { firstName: "Lotte", lastName: "Peeters-AiRo", email: "lotte.ai-ro@example.com", isTester: false });
  restricted = await makePerson(db, { firstName: "Restricted", email: "restricted.ai-ro@example.com", isTester: false });
  const tester = await makePerson(db, { firstName: "Tester", email: "tester.ai-ro@example.com", isTester: true });
  await makePaidOrder(db, { personId: lotte.id, order: { paidAt: new Date("2026-10-01T10:00:00Z") } });
  await makePaidOrder(db, { personId: restricted.id, order: { paidAt: new Date("2026-10-02T10:00:00Z") } });
  await makePaidOrder(db, { personId: tester.id, order: { paidAt: new Date("2026-10-03T10:00:00Z") } });
  await db.update(persons).set({ processingRestrictedAt: new Date() }).where(eq(persons.id, restricted.id));
}, 120_000);
afterAll(() => handle.close());

describe("0101_ai_views_ops.sql", () => {
  it("creates every view the schema doc describes, each readable by beam_ai_ro and not writable", async () => {
    const rels = await q<{ name: string }>(
      "select c.relname::text as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'ai' and c.relkind = 'v'",
    );
    const names = rels.map((r) => r.name);
    for (const view of AI_VIEWS) expect(names, view.name).toContain(view.name.replace(/^ai\./, ""));
    for (const name of names) {
      const [p] = await q<{ sel: boolean; ins: boolean; upd: boolean; del: boolean }>(
        `select has_table_privilege('beam_ai_ro', 'ai.${name}', 'select') as sel, has_table_privilege('beam_ai_ro', 'ai.${name}', 'insert') as ins,
                has_table_privilege('beam_ai_ro', 'ai.${name}', 'update') as upd, has_table_privilege('beam_ai_ro', 'ai.${name}', 'delete') as del`,
      );
      expect(p, name).toEqual({ sel: true, ins: false, upd: false, del: false });
    }
    // forms-P10's two views are granted too.
    expect(names).toEqual(expect.arrayContaining(["form_funnel_daily", "form_outcomes"]));
  });

  it("reads ai.customers and ai.webinar_performance_daily through runAiReadOnlyQuery", async () => {
    const customers = await runAiReadOnlyQuery(ctx(), "select person_id, first_name, revenue_cents from ai.customers order by first_name");
    expect(customers.columns).toEqual(["person_id", "first_name", "revenue_cents"]);
    const firstNames = customers.rows.map((r) => r[1]);
    expect(firstNames).toContain("Lotte");
    // Testers and restricted people are not customers of the ai schema.
    expect(firstNames).not.toContain("Tester");
    expect(firstNames).not.toContain("Restricted");

    const webinars = await runAiReadOnlyQuery(ctx(), "select * from ai.webinar_performance_daily");
    expect(webinars.columns).toEqual([...WEBINAR_PERFORMANCE_DAILY_COLUMNS]);

    const forms = await runAiReadOnlyQuery(ctx(), "select count(*) as n from ai.form_funnel_daily");
    expect(forms.columns).toEqual(["n"]);
  });

  it("keeps a restricted person's revenue but not their person_id, and leaves testers out", async () => {
    const orders = await runAiReadOnlyQuery(ctx(), "select person_id, total_cents from ai.orders order by paid_at");
    expect(orders.rows).toHaveLength(2);
    expect(orders.rows[0]![0]).toBe(lotte.id);
    expect(orders.rows[1]![0]).toBeNull();
    const lines = await runAiReadOnlyQuery(ctx(), "select count(*)::int as n from ai.order_lines");
    expect(lines.rows).toEqual([[2]]);
  });

  it("every ai view runs as beam_ai_ro", async () => {
    for (const view of AI_VIEWS) {
      const out = await runAiReadOnlyQuery(ctx(), `select * from ${view.name} limit 1`);
      expect(out.columns.length, view.name).toBeGreaterThan(0);
    }
  });

  it("cannot read public.persons and cannot insert, even past the guard", async () => {
    expect(await q("select has_table_privilege('beam_ai_ro', 'public.persons', 'select') as can")).toEqual([{ can: false }]);
    await expect(runAiReadOnlyQuery(ctx(), "select email from public.persons")).rejects.toThrow(/relation_outside_ai/);
    // Past the guard, Postgres itself refuses the role (the way the runner switches to it).
    const asRole = (text: string) =>
      db
        .transaction(async (tx) => {
          await tx.execute(sql.raw("set transaction read only"));
          await tx.execute(sql.raw("set local role beam_ai_ro"));
          await tx.execute(sql.raw("set local search_path = ai"));
          await tx.execute(sql.raw(text));
        })
        .then(
          () => "ran",
          (e: unknown) => String((e as { cause?: unknown })?.cause ?? e),
        );
    expect(await asRole("select email from public.persons")).toMatch(/permission denied/i);
    // Unqualified names resolve in `ai` only.
    expect(await asRole("select email from persons")).toMatch(/does not exist/i);
    expect(await asRole("select first_name from ai.customers")).toBe("ran");

    await expect(runAiReadOnlyQuery(ctx(), "insert into ai.ad_spend_daily (platform) values ('meta')")).rejects.toThrow(/first_keyword|forbidden_word/);
    const inserted = await db
      .transaction(async (tx) => {
        await tx.execute(sql.raw("set local role beam_ai_ro"));
        await tx.execute(sql.raw("insert into ai.orders (order_id) values (gen_random_uuid())"));
      })
      .catch((e: unknown) => e);
    expect(String((inserted as { cause?: unknown })?.cause ?? inserted)).toMatch(/permission denied|cannot insert/i);
  });

  it("no ai view exposes a SENSITIVE_COLUMNS member, email, phone or last_name", async () => {
    const cols = await q<{ table_name: string; column_name: string }>(
      "select table_name::text as table_name, column_name::text as column_name from information_schema.columns where table_schema = 'ai'",
    );
    expect(cols.length).toBeGreaterThan(0);
    const names = new Set(cols.map((c) => c.column_name));
    const forbidden = [
      ...SENSITIVE_COLUMNS.map((c) => c.column),
      ...SENSITIVE_FIELD_KEYS,
      "email",
      "phone",
      "last_name",
      "address",
      "street",
      "notes",
      "note",
      "answers",
      "birth_date",
    ];
    for (const name of forbidden) expect(names.has(name), name).toBe(false);
    for (const c of cols) expect(c.column_name, `${c.table_name}.${c.column_name}`).not.toMatch(/email|phone|last_name|_enc$/);
  });
});
