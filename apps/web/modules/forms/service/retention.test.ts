/** forms-P3: retention sweep handlers (section 9, SE5, cross-module D37). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { formImportEvents, formImportSources, formSensitiveAnswers, formSubmissions, formViewsDaily } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { eq, inArray } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { privacy } from "../privacy";
import { createForm, lead, setupEnv } from "../forms-p3.fixtures";
import { storeSensitive } from "./sensitive";
import { sweep } from "./retention";

let h: DbHandle;
let form: { formId: string; versionId: string };
beforeAll(async () => {
  setupEnv();
  h = await createTestDb();
  form = await createForm(h.db, lead());
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const OLD = new Date("2020-01-01T10:00:00Z");
const NEW = new Date();
const CUTOFF = new Date("2021-01-01T00:00:00Z");
type Status = "started" | "partial" | "abandoned" | "completed";

async function sub(o: { status?: Status; at?: Date; personId?: string | null; ipHash?: string | null }) {
  const at = o.at ?? NEW;
  const status = o.status ?? "completed";
  const [r] = await h.db
    .insert(formSubmissions)
    .values({
      formId: form.formId,
      formVersionId: form.versionId,
      status,
      funnel: "contact",
      locale: "nl-BE",
      personId: o.personId ?? null,
      startedAt: at,
      lastActivityAt: at,
      completedAt: status === "completed" ? at : null,
      abandonedAt: status === "abandoned" ? at : null,
      ipHash: o.ipHash ?? null,
    })
    .returning();
  return r!;
}

const run = (key: keyof typeof sweep, cutoff = CUTOFF) => h.db.transaction((tx) => sweep[key](tx as Tx, cutoff));
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
const existing = async (list: string[]) => ids(await h.db.select({ id: formSubmissions.id }).from(formSubmissions).where(inArray(formSubmissions.id, list)));

describe("sweep map", () => {
  it("has exactly the seven keys of section 9, each a valid policy key, and is the privacy registration's", () => {
    expect(Object.keys(sweep).sort()).toEqual(
      [
        "forms.form_import_events",
        "forms.form_sensitive_answers",
        "forms.form_sensitive_answers_unlinked",
        "forms.form_submissions",
        "forms.form_submissions_anonymous_abandoned",
        "forms.form_submissions_ip_hash",
        "forms.form_views_daily",
      ].sort(),
    );
    for (const k of Object.keys(sweep)) expect(k).toMatch(/^[a-z]+\.[a-z][a-z0-9_]*$/);
    expect(privacy.sweep).toBe(sweep);
    for (const r of privacy.retention ?? []) expect(Object.keys(sweep)).toContain(r.key);
  });
});

describe("handlers delete only rows past the cutoff and return the count", () => {
  it("forms.form_submissions (sensitive rows cascade)", async () => {
    await run("forms.form_submissions");
    const old = await sub({ at: OLD });
    const fresh = await sub({});
    await storeSensitive(h.db, { submissionId: old.id, personId: null, values: { notes: "x" } });
    expect(await run("forms.form_submissions")).toBe(1);
    expect(await existing([old.id, fresh.id])).toEqual([fresh.id]);
    expect(await h.db.select().from(formSensitiveAnswers).where(eq(formSensitiveAnswers.submissionId, old.id))).toHaveLength(0);
    expect(await run("forms.form_submissions")).toBe(0);
  });

  it("forms.form_sensitive_answers", async () => {
    await run("forms.form_sensitive_answers");
    const old = await sub({ at: OLD });
    const fresh = await sub({});
    await storeSensitive(h.db, { submissionId: old.id, personId: null, values: { a: 1, b: 2 } });
    await storeSensitive(h.db, { submissionId: fresh.id, personId: null, values: { a: 1 } });
    expect(await run("forms.form_sensitive_answers")).toBe(2);
    expect(await h.db.select().from(formSensitiveAnswers).where(eq(formSensitiveAnswers.submissionId, fresh.id))).toHaveLength(1);
    expect(await existing([old.id])).toEqual([old.id]);
    expect(await run("forms.form_sensitive_answers")).toBe(0);
  });

  it("forms.form_submissions_anonymous_abandoned (SE5)", async () => {
    await run("forms.form_submissions_anonymous_abandoned");
    const p = await makePerson(h.db);
    const anonOld = await sub({ status: "abandoned", at: OLD });
    const knownOld = await sub({ status: "abandoned", at: OLD, personId: p.id });
    const anonNew = await sub({ status: "abandoned" });
    const completedOld = await sub({ at: OLD });
    expect(await run("forms.form_submissions_anonymous_abandoned")).toBe(1);
    expect((await existing([anonOld.id, knownOld.id, anonNew.id, completedOld.id])).sort()).toEqual([knownOld.id, anonNew.id, completedOld.id].sort());
    expect(await run("forms.form_submissions_anonymous_abandoned")).toBe(0);
  });

  it("forms.form_sensitive_answers_unlinked", async () => {
    await run("forms.form_sensitive_answers_unlinked", new Date(Date.now() + 60_000));
    const open = await sub({ status: "partial" });
    const done = await sub({});
    await storeSensitive(h.db, { submissionId: open.id, personId: null, values: { a: 1 } });
    await storeSensitive(h.db, { submissionId: done.id, personId: null, values: { a: 1 } });
    expect(await run("forms.form_sensitive_answers_unlinked", CUTOFF)).toBe(0); // created now, not past the cutoff
    expect(await run("forms.form_sensitive_answers_unlinked", new Date(Date.now() + 60_000))).toBe(1);
    expect(await h.db.select().from(formSensitiveAnswers).where(eq(formSensitiveAnswers.submissionId, done.id))).toHaveLength(1);
    expect(await run("forms.form_sensitive_answers_unlinked", new Date(Date.now() + 60_000))).toBe(0);
  });

  it("forms.form_submissions_ip_hash (anonymises)", async () => {
    await run("forms.form_submissions_ip_hash");
    const old = await sub({ at: OLD, ipHash: "a".repeat(64) });
    const fresh = await sub({ ipHash: "b".repeat(64) });
    expect(await run("forms.form_submissions_ip_hash")).toBe(1);
    const rows = await h.db.select().from(formSubmissions).where(inArray(formSubmissions.id, [old.id, fresh.id]));
    expect(rows.find((r) => r.id === old.id)!.ipHash).toBeNull();
    expect(rows.find((r) => r.id === fresh.id)!.ipHash).toBe("b".repeat(64));
    expect(await run("forms.form_submissions_ip_hash")).toBe(0);
  });

  it("forms.form_import_events", async () => {
    await run("forms.form_import_events");
    const u = await makeUser(h.db);
    const [src] = await h.db
      .insert(formImportSources)
      .values({ key: "abcdefabcdef", provider: "scoreapp", name: "ScoreApp", formId: form.formId, tokenHash: "c".repeat(64), mapping: {}, createdByUserId: u.id })
      .returning();
    const linked = await sub({});
    const [oldEv] = await h.db.insert(formImportEvents).values({ sourceId: src!.id, externalId: "old", payload: {}, receivedAt: OLD, submissionId: linked.id }).returning();
    await h.db.update(formSubmissions).set({ importEventId: oldEv!.id }).where(eq(formSubmissions.id, linked.id));
    await h.db.insert(formImportEvents).values({ sourceId: src!.id, externalId: "new", payload: {} });
    expect(await run("forms.form_import_events")).toBe(1);
    expect((await h.db.select().from(formImportEvents).where(eq(formImportEvents.sourceId, src!.id))).map((e) => e.externalId)).toEqual(["new"]);
    expect(await existing([linked.id])).toEqual([linked.id]);
    expect(await run("forms.form_import_events")).toBe(0);
  });

  it("forms.form_views_daily", async () => {
    await run("forms.form_views_daily");
    await h.db.insert(formViewsDaily).values([
      { formId: form.formId, dayOn: "2019-06-01", locale: "nl-BE", views: 3 },
      { formId: form.formId, dayOn: "2026-06-01", locale: "nl-BE", views: 5 },
    ]);
    expect(await run("forms.form_views_daily")).toBe(1);
    expect((await h.db.select().from(formViewsDaily).where(eq(formViewsDaily.formId, form.formId))).map((r) => r.dayOn)).toEqual(["2026-06-01"]);
    expect(await run("forms.form_views_daily")).toBe(0);
  });
});
