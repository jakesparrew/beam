/** forms-P2: version service (immutable published rows, P1 to P9, the P7 DPIA gate). */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { forms, formVersions } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import { canonicalHash, recoveryCheckSeed, seedDefinitions } from "@beam/core/forms";
import { eq } from "@/lib/ctx";

const dpia = vi.hoisted(() => ({ approved: false, calls: 0 }));
vi.mock("@/modules/ops/api", () => ({
  isDpiaApproved: vi.fn((_db: unknown, key: string) => {
    dpia.calls++;
    expect(key).toBe("sensitive_assessment_processing");
    return Promise.resolve(dpia.approved);
  }),
}));

const { copyToDraft, findDraft, insertDraftVersion, parseVersion, publishFormVersion, PublishRefusedError, updateDraftVersion } = await import("./versions");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(() => h.close());
beforeEach(() => {
  dpia.approved = false;
  dpia.calls = 0;
});

let n = 0;
async function newForm(kind: "lead" | "assessment" | "intake" = "lead") {
  const [row] = await h.db.insert(forms).values({ slug: `p2-form-${++n}`, kind, name: { en: "Test" } }).returning();
  return row!;
}

describe("form versions service", () => {
  it("inserts a draft with derived columns and allows one draft per form", async () => {
    const f = await newForm();
    const c = seedDefinitions().contact;
    const d = await insertDraftVersion(h.db, { formId: f.id, ...c, createdByUserId: null });
    expect(d.version).toBe(1);
    const [row] = await h.db.select().from(formVersions).where(eq(formVersions.id, d.versionId));
    expect(row).toMatchObject({ consentPurposes: ["newsletter"], sensitiveFieldKeys: [], definitionHash: canonicalHash(c.definition, c.scoring), publishedAt: null });
    await expect(insertDraftVersion(h.db, { formId: f.id, ...c, createdByUserId: null })).rejects.toThrow(/draft_exists/);
    expect(parseVersion(row!).definition.title).toEqual(c.definition.title);
  });

  it("updateDraftVersion checks expectedHash and never touches a published row", async () => {
    const f = await newForm();
    const c = seedDefinitions().contact;
    const d = await insertDraftVersion(h.db, { formId: f.id, ...c, createdByUserId: null });
    const changed = { ...c, definition: { ...c.definition, title: { ...c.definition.title, en: "Write to us" } } };
    await expect(updateDraftVersion(h.db, { versionId: d.versionId, ...changed, expectedHash: "stale" })).rejects.toThrow(/draft_changed_or_published/);
    const u = await updateDraftVersion(h.db, { versionId: d.versionId, ...changed, expectedHash: d.definitionHash });
    expect(u.definitionHash).not.toBe(d.definitionHash);
    await publishFormVersion(h.db, { formId: f.id, versionId: d.versionId, publishedByUserId: null });
    await expect(updateDraftVersion(h.db, { versionId: d.versionId, ...c })).rejects.toThrow(/draft_changed_or_published/);
    const [row] = await h.db.select().from(formVersions).where(eq(formVersions.id, d.versionId));
    expect(row!.definitionHash).toBe(u.definitionHash);
  });

  it("P9: publishing sets published_at, the current version and the published status; a published version cannot publish twice", async () => {
    const f = await newForm();
    const d = await insertDraftVersion(h.db, { formId: f.id, ...seedDefinitions().newsletter, createdByUserId: null });
    const now = new Date("2026-11-04T10:00:00Z");
    const r = await publishFormVersion(h.db, { formId: f.id, versionId: d.versionId, publishedByUserId: null, changeNote: "first", now });
    expect(r.version).toBe(1);
    const [form] = await h.db.select().from(forms).where(eq(forms.id, f.id));
    expect(form).toMatchObject({ status: "published", currentVersionId: d.versionId });
    const [v] = await h.db.select().from(formVersions).where(eq(formVersions.id, d.versionId));
    expect(v).toMatchObject({ publishedAt: now, changeNote: "first" });
    await expect(publishFormVersion(h.db, { formId: f.id, versionId: d.versionId, publishedByUserId: null })).rejects.toThrow(/version_published/);
    expect(dpia.calls).toBe(0);
  });

  it("P9: a new draft copies the current version into version + 1", async () => {
    const f = await newForm();
    const d = await insertDraftVersion(h.db, { formId: f.id, ...seedDefinitions().contact, createdByUserId: null });
    await publishFormVersion(h.db, { formId: f.id, versionId: d.versionId, publishedByUserId: null });
    const copy = await copyToDraft(h.db, { formId: f.id, createdByUserId: null });
    expect(copy.version).toBe(2);
    expect((await findDraft(h.db, f.id))!.id).toBe(copy.versionId);
    await expect(copyToDraft(h.db, { formId: f.id, createdByUserId: null })).rejects.toThrow(/draft_exists/);
  });

  it("P1: an invalid draft is refused with every issue", async () => {
    const f = await newForm();
    const c = seedDefinitions().contact;
    c.definition.endings = [];
    delete c.definition.title["fr-BE"];
    const d = await insertDraftVersion(h.db, { formId: f.id, ...c, createdByUserId: null });
    const err = await publishFormVersion(h.db, { formId: f.id, versionId: d.versionId, publishedByUserId: null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishRefusedError);
    expect((err as InstanceType<typeof PublishRefusedError>).issues.map((i) => i.code)).toEqual(expect.arrayContaining(["incomplete_text", "no_ending"]));
    expect((err as InstanceType<typeof PublishRefusedError>).code).toBe("validation");
    const [form] = await h.db.select().from(forms).where(eq(forms.id, f.id));
    expect(form!.status).toBe("draft");
  });

  it("P7: a version with sensitive fields needs the DPIA approved; without sensitive fields it is never asked", async () => {
    const f = await newForm("intake");
    const hd = seedDefinitions()["health-declaration"];
    const d = await insertDraftVersion(h.db, { formId: f.id, ...hd, createdByUserId: null });
    const err = await publishFormVersion(h.db, { formId: f.id, versionId: d.versionId, publishedByUserId: null }).catch((e: unknown) => e);
    expect((err as InstanceType<typeof PublishRefusedError>).issues[0]).toMatchObject({ code: "dpia_not_approved", level: "error" });
    expect(dpia.calls).toBe(1);
    dpia.approved = true;
    await expect(publishFormVersion(h.db, { formId: f.id, versionId: d.versionId, publishedByUserId: null })).resolves.toMatchObject({ version: 1 });
  });

  it("the demo seed may skip the DPIA check", async () => {
    const f = await newForm("assessment");
    const rc = recoveryCheckSeed({ baseUrl: "https://beam.example.com" });
    const d = await insertDraftVersion(h.db, { formId: f.id, ...rc, createdByUserId: null });
    await publishFormVersion(h.db, { formId: f.id, versionId: d.versionId, publishedByUserId: null }, { skipDpiaCheck: "demo_seed" });
    expect(dpia.calls).toBe(0);
  });

  it("an archived form or a version of another form is refused", async () => {
    const f = await newForm();
    const other = await newForm();
    const d = await insertDraftVersion(h.db, { formId: f.id, ...seedDefinitions().contact, createdByUserId: null });
    await expect(publishFormVersion(h.db, { formId: other.id, versionId: d.versionId, publishedByUserId: null })).rejects.toThrow(/version_not_found/);
    await expect(publishFormVersion(h.db, { formId: "00000000-0000-4000-8000-000000000009", versionId: d.versionId, publishedByUserId: null })).rejects.toThrow(/form_not_found/);
    await publishFormVersion(h.db, { formId: f.id, versionId: d.versionId, publishedByUserId: null });
    await h.db.update(forms).set({ status: "archived", archivedAt: new Date() }).where(eq(forms.id, f.id));
    const copy = await copyToDraft(h.db, { formId: f.id, createdByUserId: null });
    await expect(publishFormVersion(h.db, { formId: f.id, versionId: copy.versionId, publishedByUserId: null })).rejects.toThrow(/form_archived/);
  });

  it("F7: an oversized draft is refused", async () => {
    const f = await newForm();
    const c = seedDefinitions().contact;
    c.definition.intro = { en: "x".repeat(300 * 1024) };
    await expect(insertDraftVersion(h.db, { formId: f.id, ...c, createdByUserId: null })).rejects.toThrow(/limit_exceeded/);
  });
});
