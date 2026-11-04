/** forms-P2 demo seed: health-declaration and recovery-check published, 30 submissions, idempotent. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { forms, formSensitiveAnswers, formSubmissions, formVersions } from "@beam/db/schema";
import { seedDefaults } from "@beam/db/seed";
import { createTestDb, makePerson } from "@beam/db/testing";
import { eq, sql } from "@/lib/ctx";
import { decryptSensitive, rowsOf, sensitiveAad, sensitiveKey } from "@/lib/sensitive";
import { seededRandom } from "@/scripts/seed-demo";
import { runFormsDemoSeed, seed } from "./seed";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  await seedDefaults(h.db);
  for (let i = 1; i <= 12; i++) await makePerson(h.db, { email: `crm-demo-${i}@example.com`, firstName: `Demo${i}` });
});
afterAll(() => h.close());

const count = async (q: ReturnType<typeof sql>) => Number(rowsOf<{ n: number }>(await h.db.execute(q))[0]!.n);

describe("forms demo seed", () => {
  it("runs after site", () => {
    expect(seed.after).toEqual(["site"]);
  });

  it("publishes health-declaration and recovery-check, creates 30 submissions, and nothing on a second run", async () => {
    const ids = new Map<string, string>();
    const now = new Date("2026-11-04T00:00:00Z");
    const first = await runFormsDemoSeed({ db: h.db, now, rand: seededRandom(20261103), ids });
    expect(first.published).toEqual(["health-declaration", "recovery-check"]);
    expect(first.created).toBe(30);

    const rows = await h.db.select().from(forms);
    expect(rows.find((f) => f.slug === "health-declaration")!.status).toBe("published");
    const rc = rows.find((f) => f.slug === "recovery-check")!;
    expect(rc).toMatchObject({ status: "published", kind: "assessment" });
    expect(ids.get("forms.form.recovery-check")).toBe(rc.id);
    const [v] = await h.db.select().from(formVersions).where(eq(formVersions.id, rc.currentVersionId!));
    expect(v!.sensitiveFieldKeys).toEqual(["sleep_hours", "sleep_quality", "stress_level", "stress_physical"]);

    expect(await count(sql`select count(*)::int as n from form_submissions`)).toBe(30);
    const byStatus = rowsOf<{ status: string; n: number }>(await h.db.execute(sql`select status, count(*)::int as n from form_submissions where form_id = ${rc.id} group by status order by status::text`));
    expect(byStatus).toEqual([
      { status: "abandoned", n: 2 },
      { status: "completed", n: 14 },
      { status: "partial", n: 3 },
      { status: "started", n: 1 },
    ]);
    expect(await count(sql`select count(distinct source)::int as n from form_submissions`)).toBeGreaterThanOrEqual(5);

    // SE1: no sensitive key in answers or score; outcomes and the plain total are set on completions.
    const subs = await h.db.select().from(formSubmissions).where(eq(formSubmissions.formId, rc.id));
    for (const s of subs) {
      for (const k of v!.sensitiveFieldKeys) expect(Object.keys(s.answers)).not.toContain(k);
      if (s.status === "completed") {
        expect(s.outcomeKey).toMatch(/^(reset_now|build_routine|keep_going|recovery_pro)$/);
        expect(Object.keys(s.score!.dimensions)).toEqual(["habits"]);
        expect(typeof s.score!.total).toBe("number");
        expect(s.endingKey).toMatch(/^result_/);
        expect(s.path).toEqual(["about", "sleep_stress", "habits"]);
      } else {
        expect(s.score).toBeNull();
      }
    }

    // Sensitive answers and dimensions are encrypted when the key is configured.
    const enc = await h.db.select().from(formSensitiveAnswers);
    if (sensitiveKey(1)) {
      expect(enc.length).toBeGreaterThan(0);
      const dim = enc.find((e) => e.fieldKey === "score:sleep")!;
      const value = JSON.parse(decryptSensitive(dim.valueEnc, dim.keyVersion, sensitiveAad.formAnswer(dim.submissionId, dim.fieldKey))) as { value: number };
      expect(typeof value.value).toBe("number");
    } else {
      expect(enc).toHaveLength(0);
    }

    const second = await runFormsDemoSeed({ db: h.db, now, rand: seededRandom(20261103), ids });
    expect(second).toEqual({ created: 0, published: [] });
    expect(await count(sql`select count(*)::int as n from form_submissions`)).toBe(30);
  });
});
