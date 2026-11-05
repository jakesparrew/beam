/**
 * forms-P5 staff actions (forms spec section 4, rules P1 to P13): every transition of the P12
 * status machine and the refused ones, the system slugs of P13, drafts with `expectedHash`,
 * publish refusals (sensitive data in logic, missing translation, inactive CTA, DPIA), restore as
 * draft, duplicate, tracked links, and audit rows that carry hashes only. The DPIA check is ops'
 * real `isDpiaApproved`, wrapped so the test can see whether it was called.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, dpiaRecords, formLinks, forms, formVersions, roles } from "@beam/db/schema";
import { seedDefaults } from "@beam/db/seed";
import { createTestDb, makeProduct, makeUser } from "@beam/db/testing";
import type { FormDefinition, FormScoring } from "@beam/core/forms";
import type * as OpsApi from "@/modules/ops/api";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.51" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

const dpia = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@/modules/ops/api", async (orig) => {
  const real = await orig<typeof OpsApi>();
  return {
    ...real,
    isDpiaApproved: (db: Parameters<typeof real.isDpiaApproved>[0], key: Parameters<typeof real.isDpiaApproved>[1]) => {
      dpia.calls.push(key);
      return real.isDpiaApproved(db, key);
    },
  };
});

const actions = await import("./actions");
const queries = await import("./queries");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { getPublishedForm } = await import("./service/public-queries");
const { updateDraftVersion, parseVersion } = await import("./service/versions");
const { refreshCtaWarnings } = await import("./service/cta-targets");
const { assessment, lead, setupEnv, T, uniqueSlug } = await import("./forms-p3.fixtures");

let h: DbHandle;
const clone = <X>(x: X): X => JSON.parse(JSON.stringify(x)) as X;
const body = (x: { definition: FormDefinition; scoring: FormScoring; locales: ("nl-BE" | "fr-BE" | "en")[] }) => ({ definition: x.definition, scoring: x.scoring, locales: x.locales });

type Ok<T> = { ok: true; data: T };
function ok<T>(r: unknown): T {
  expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
  return (r as Ok<T>).data;
}
function err(r: unknown, code: string): { code: string; message: string; fields?: Record<string, string> } {
  expect(r, JSON.stringify(r)).toMatchObject({ ok: false, error: { code } });
  return (r as { error: { code: string; message: string; fields?: Record<string, string> } }).error;
}

async function signIn() {
  const user = await makeUser(h.db, { roleKey: "marketing" });
  const [role] = await h.db.select().from(roles).where(eq(roles.key, "marketing"));
  const perms = new Set(role!.permissions);
  for (const p of ["forms.write", "forms.publish"]) perms.add(p);
  await h.db.update(roles).set({ permissions: [...perms] }).where(eq(roles.key, "marketing"));
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey: "marketing", now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

const setDpia = (status: "not_started" | "approved") => h.db.update(dpiaRecords).set({ status }).where(eq(dpiaRecords.key, "sensitive_assessment_processing"));

async function formRow(formId: string) {
  const [f] = await h.db.select().from(forms).where(eq(forms.id, formId));
  return f!;
}
async function versionRow(id: string) {
  const [v] = await h.db.select().from(formVersions).where(eq(formVersions.id, id));
  return v!;
}

/** A new form whose draft holds `content` (the lead fixture by default); returns the ids and hash. */
async function draftWith(content: { definition: FormDefinition; scoring: FormScoring; locales?: ("nl-BE" | "fr-BE" | "en")[] }, kind: "lead" | "assessment" = "lead") {
  const slug = uniqueSlug(kind);
  const created = ok<{ formId: string; versionId: string }>(await actions.createForm({ slug, kind, name: T("Form"), locales: ["nl-BE", "fr-BE", "en"] }));
  const v = await versionRow(created.versionId);
  const saved = ok<{ definitionHash: string }>(
    await actions.saveDraft({ formId: created.formId, versionId: created.versionId, definition: content.definition, scoring: content.scoring, locales: content.locales ?? ["nl-BE", "fr-BE", "en"], expectedHash: v.definitionHash }),
  );
  return { ...created, slug, hash: saved.definitionHash };
}

beforeAll(async () => {
  setupEnv();
  h = await createTestDb();
  setAppDb(h.db);
  await seedDefaults(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  jar.clear();
  dpia.calls = [];
  await setDpia("not_started");
  await signIn();
});

describe("P12 status machine", () => {
  it("(none) -> draft: createForm makes a draft with version 1; a taken slug is a field error", async () => {
    const slug = uniqueSlug("lead");
    const r = ok<{ formId: string; versionId: string }>(await actions.createForm({ slug, kind: "lead", name: T("Lead"), locales: ["nl-BE", "en"], template: "lead" }));
    const f = await formRow(r.formId);
    expect(f).toMatchObject({ slug, status: "draft", currentVersionId: null });
    const v = await versionRow(r.versionId);
    expect(v).toMatchObject({ version: 1, publishedAt: null, locales: ["nl-BE", "en"] });
    expect(parseVersion(v).definition.fields.email).toMatchObject({ type: "email", mapsTo: "person.email", required: true });
    const again = err(await actions.createForm({ slug, kind: "lead", name: T("Lead"), locales: ["nl-BE"] }), "validation");
    expect(again.fields).toEqual({ slug: "slug_taken" });
    err(await actions.createForm({ slug: "result", kind: "lead", name: T("Lead"), locales: ["nl-BE"] }), "validation");
  });

  it("create -> save -> publish -> edit creates a version + 1 draft; publishing it moves current_version_id", async () => {
    const d = await draftWith(lead());
    const pub = ok<{ version: number }>(await actions.publishVersion({ formId: d.formId, versionId: d.versionId, changeNote: "First" }));
    expect(pub.version).toBe(1);
    expect(await formRow(d.formId)).toMatchObject({ status: "published", currentVersionId: d.versionId });

    const draft = ok<{ versionId: string }>(await actions.createDraft({ formId: d.formId }));
    expect((await versionRow(draft.versionId)).version).toBe(2);
    err(await actions.createDraft({ formId: d.formId }), "conflict");

    const content = lead();
    content.definition.title = T("Second title");
    const v2 = await versionRow(draft.versionId);
    ok(await actions.saveDraft({ formId: d.formId, versionId: draft.versionId, ...body(content), expectedHash: v2.definitionHash }));
    expect(ok<{ version: number }>(await actions.publishVersion({ formId: d.formId, versionId: draft.versionId, changeNote: "Second" })).version).toBe(2);
    expect(await formRow(d.formId)).toMatchObject({ status: "published", currentVersionId: draft.versionId });
    expect((await versionRow(d.versionId)).publishedAt).not.toBeNull();
  });

  it("published -> archived -> published; archived forms answer closed to the public", async () => {
    const d = await draftWith(lead());
    ok(await actions.publishVersion({ formId: d.formId, versionId: d.versionId, changeNote: "Go" }));
    ok(await actions.archiveForm({ formId: d.formId }));
    expect(await formRow(d.formId)).toMatchObject({ status: "archived" });
    expect((await formRow(d.formId)).archivedAt).not.toBeNull();
    expect(await getPublishedForm(h.db, d.slug, "nl-BE")).toEqual({ closed: true });
    err(await actions.archiveForm({ formId: d.formId }), "conflict");
    err(await actions.deleteForm({ formId: d.formId }), "conflict");

    ok(await actions.unarchiveForm({ formId: d.formId }));
    expect(await formRow(d.formId)).toMatchObject({ status: "published", archivedAt: null, currentVersionId: d.versionId });
    expect(await getPublishedForm(h.db, d.slug, "nl-BE")).toMatchObject({ formId: d.formId, versionId: d.versionId });
    err(await actions.unarchiveForm({ formId: d.formId }), "conflict");
  });

  it("refuses archiveForm on a draft and deleteForm on a published form with conflict", async () => {
    const d = await draftWith(lead());
    expect(err(await actions.archiveForm({ formId: d.formId }), "conflict").message).toBe("form_is_draft_delete_instead");
    ok(await actions.publishVersion({ formId: d.formId, versionId: d.versionId, changeNote: "Go" }));
    expect(err(await actions.deleteForm({ formId: d.formId }), "conflict").message).toBe("form_was_published");
    expect(await formRow(d.formId)).toMatchObject({ status: "published" });
  });

  it("draft -> (deleted): deleteForm removes a never-published form with its versions and links", async () => {
    const d = await draftWith(lead());
    ok(await actions.createLink({ formId: d.formId, name: "Flyer", channel: "print" }));
    ok(await actions.deleteForm({ formId: d.formId }));
    expect(await h.db.select().from(forms).where(eq(forms.id, d.formId))).toEqual([]);
    expect(await h.db.select().from(formVersions).where(eq(formVersions.formId, d.formId))).toEqual([]);
    expect(await h.db.select().from(formLinks).where(eq(formLinks.formId, d.formId))).toEqual([]);
    const [a] = await h.db.select().from(auditLog).where(eq(auditLog.entityId, d.formId)).orderBy(auditLog.id);
    expect(a).toBeTruthy();
  });
});

describe("P13 system forms", () => {
  it("refuses archive and delete of health-declaration, contact and newsletter", async () => {
    for (const slug of ["health-declaration", "contact", "newsletter"]) {
      const [f] = await h.db.select().from(forms).where(eq(forms.slug, slug));
      expect(f, slug).toBeTruthy();
      expect(err(await actions.archiveForm({ formId: f!.id }), "conflict").message).toBe("system_form");
      expect(err(await actions.deleteForm({ formId: f!.id }), "conflict").message).toBe("system_form");
    }
    const [hd] = await h.db.select().from(forms).where(eq(forms.slug, "health-declaration"));
    err(await actions.updateFormMeta({ formId: hd!.id, slug: "health-declaration-2" }), "conflict");
    expect(err(await actions.duplicateForm({ formId: hd!.id, newSlug: "contact", name: T("Copy") }), "validation").fields).toEqual({ newSlug: "slug_taken" });
  });

  it("re-running the defaults seed keeps the slug and the staff-published current version", async () => {
    const [contact] = await h.db.select().from(forms).where(eq(forms.slug, "contact"));
    const draft = ok<{ versionId: string }>(await actions.createDraft({ formId: contact!.id }));
    ok(await actions.publishVersion({ formId: contact!.id, versionId: draft.versionId, changeNote: "Staff edit" }));
    await seedDefaults(h.db);
    const after = await formRow(contact!.id);
    expect(after).toMatchObject({ slug: "contact", status: "published", currentVersionId: draft.versionId });
    expect((await versionRow(draft.versionId)).publishedByUserId).not.toBeNull();
  });
});

describe("drafts", () => {
  it("expectedHash conflict when another editor saved", async () => {
    const d = await draftWith(lead());
    const other = lead();
    other.definition.title = T("Other editor");
    ok(await actions.saveDraft({ formId: d.formId, versionId: d.versionId, ...body(other), expectedHash: d.hash }));
    const mine = lead();
    mine.definition.title = T("Mine");
    err(await actions.saveDraft({ formId: d.formId, versionId: d.versionId, ...body(mine), expectedHash: d.hash }), "conflict");
  });

  it("a published row is never updated (saveDraft and the service refuse it)", async () => {
    const d = await draftWith(lead());
    ok(await actions.publishVersion({ formId: d.formId, versionId: d.versionId, changeNote: "Go" }));
    const before = await versionRow(d.versionId);
    err(await actions.saveDraft({ formId: d.formId, versionId: d.versionId, ...body(lead()), expectedHash: before.definitionHash }), "conflict");
    const changed = lead();
    changed.definition.title = T("Rewrite history");
    await expect(updateDraftVersion(h.db, { versionId: d.versionId, ...body(changed) })).rejects.toMatchObject({ code: "conflict" });
    expect(await versionRow(d.versionId)).toEqual(before);
  });

  it("restores an old version as a new draft", async () => {
    const d = await draftWith(lead());
    ok(await actions.publishVersion({ formId: d.formId, versionId: d.versionId, changeNote: "v1" }));
    const v1 = await versionRow(d.versionId);
    const draft = ok<{ versionId: string }>(await actions.createDraft({ formId: d.formId }));
    const c = lead();
    c.definition.title = T("v2");
    ok(await actions.saveDraft({ formId: d.formId, versionId: draft.versionId, ...body(c), expectedHash: (await versionRow(draft.versionId)).definitionHash }));
    ok(await actions.publishVersion({ formId: d.formId, versionId: draft.versionId, changeNote: "v2" }));

    const restored = ok<{ versionId: string }>(await actions.createDraft({ formId: d.formId, fromVersionId: v1.id }));
    const r = await versionRow(restored.versionId);
    expect(r).toMatchObject({ version: 3, publishedAt: null, definitionHash: v1.definitionHash });

    ok(await actions.discardDraft({ formId: d.formId, versionId: restored.versionId }));
    expect(await h.db.select().from(formVersions).where(eq(formVersions.id, restored.versionId))).toEqual([]);
  });

  it("duplicateForm copies the current version into a new draft form", async () => {
    const d = await draftWith(lead());
    ok(await actions.publishVersion({ formId: d.formId, versionId: d.versionId, changeNote: "Go" }));
    const slug = uniqueSlug("copy");
    const r = ok<{ formId: string }>(await actions.duplicateForm({ formId: d.formId, newSlug: slug, name: T("Copy") }));
    const f = await formRow(r.formId);
    expect(f).toMatchObject({ slug, status: "draft", kind: "lead" });
    const [v] = await h.db.select().from(formVersions).where(eq(formVersions.formId, r.formId));
    expect(v).toMatchObject({ version: 1, publishedAt: null, definitionHash: (await versionRow(d.versionId)).definitionHash });
    const [a] = await h.db.select().from(auditLog).where(eq(auditLog.entityId, r.formId));
    expect(a).toMatchObject({ action: "forms.created" });
    expect(JSON.stringify(a!.newValue)).toContain("duplicatedFrom");
  });

  it("updateFormMeta renames and changes the slug only while never published", async () => {
    const d = await draftWith(lead());
    const slug = uniqueSlug("renamed");
    ok(await actions.updateFormMeta({ formId: d.formId, slug, name: T("Renamed"), description: "Internal note" }));
    expect(await formRow(d.formId)).toMatchObject({ slug, description: "Internal note" });
    ok(await actions.publishVersion({ formId: d.formId, versionId: d.versionId, changeNote: "Go" }));
    expect(err(await actions.updateFormMeta({ formId: d.formId, slug: uniqueSlug("again") }), "conflict").message).toBe("slug_locked_after_publish");
  });
});

describe("publish refusals", () => {
  it("fails with sensitive_in_logic for a goto on a sensitive field", async () => {
    await setDpia("approved");
    const a = assessment();
    a.definition.logic = [{ key: "skip_habits", afterSection: "sleep_stress", if: { field: "sleep_quality", op: "gte", value: 3 }, then: { goto: "habits" } }];
    const d = await draftWith(a, "assessment");
    const e = err(await actions.publishVersion({ formId: d.formId, versionId: d.versionId, changeNote: "Go" }), "validation");
    expect(Object.values(e.fields ?? {})).toContain("sensitive_in_logic");
    expect((await versionRow(d.versionId)).publishedAt).toBeNull();
  });

  it("fails with the issue list on a missing fr-BE label and on an inactive product CTA", async () => {
    const c = lead();
    c.definition.fields.first_name!.label = { "nl-BE": "Voornaam", en: "First name" };
    const product = await makeProduct(h.db, { isActive: false });
    c.definition.endings[0]!.ctas = [{ key: "shop", kind: "product", productId: product.id, label: T("Shop") }];
    const d = await draftWith(c);
    const e = err(await actions.publishVersion({ formId: d.formId, versionId: d.versionId, changeNote: "Go" }), "validation");
    expect(e.fields).toMatchObject({ "fields.first_name.label": "incomplete_text" });
    expect(Object.entries(e.fields ?? {}).find(([, code]) => code === "cta_target_missing")?.[0]).toContain(`ctas.shop`);
    expect((await formRow(d.formId)).status).toBe("draft");
  });

  it("a sensitive version fails with dpia_not_approved until ops approves the DPIA; a version without sensitive fields never asks", async () => {
    const plain = await draftWith(lead());
    ok(await actions.publishVersion({ formId: plain.formId, versionId: plain.versionId, changeNote: "Go" }));
    expect(dpia.calls).toEqual([]);

    const d = await draftWith(assessment(), "assessment");
    const e = err(await actions.publishVersion({ formId: d.formId, versionId: d.versionId, changeNote: "Go" }), "validation");
    expect(Object.values(e.fields ?? {})).toContain("dpia_not_approved");
    expect(dpia.calls).toEqual(["sensitive_assessment_processing"]);
    await setDpia("approved");
    expect(ok<{ version: number }>(await actions.publishVersion({ formId: d.formId, versionId: d.versionId, changeNote: "Go" })).version).toBe(1);
  });

  it("refuses skipDpiaCheck from any action caller", async () => {
    const d = await draftWith(assessment(), "assessment");
    err(await actions.publishVersion({ formId: d.formId, versionId: d.versionId, changeNote: "Go", skipDpiaCheck: "demo_seed" }), "validation");
    expect((await versionRow(d.versionId)).publishedAt).toBeNull();
    expect(dpia.calls).toEqual([]);
  });

  it("the overview shows cta_warnings", async () => {
    const c = lead();
    const product = await makeProduct(h.db, { isActive: true });
    c.definition.endings[0]!.ctas = [{ key: "shop", kind: "product", productId: product.id, label: T("Shop") }];
    const d = await draftWith(c);
    ok(await actions.publishVersion({ formId: d.formId, versionId: d.versionId, changeNote: "Go" }));
    expect((await queries.getForm(h.db, d.formId))!.ctaWarnings).toEqual([]);
    await h.db.execute(`update products set is_active = false where id = '${product.id}'` as never);
    await refreshCtaWarnings(h.db);
    const detail = await queries.getForm(h.db, d.formId);
    expect(detail!.ctaWarnings).toEqual([{ endingKey: c.definition.endings[0]!.key, ctaKey: "shop", reason: "inactive_product" }]);
    expect(detail).toMatchObject({ status: "published", everPublished: true, draft: null, current: { id: d.versionId, version: 1 } });
  });
});

describe("audit and links", () => {
  it("audit rows of drafts and publishing carry hashes only", async () => {
    const d = await draftWith(lead());
    ok(await actions.publishVersion({ formId: d.formId, versionId: d.versionId, changeNote: "Go" }));
    const saved = await h.db.select().from(auditLog).where(eq(auditLog.entityId, d.versionId));
    const draftSaved = saved.find((a) => a.action === "forms.draft_saved")!;
    expect(draftSaved.newValue).toEqual({ definitionHash: d.hash });
    expect(Object.keys(draftSaved.oldValue as object)).toEqual(["definitionHash"]);
    const [published] = await h.db.select().from(auditLog).where(eq(auditLog.action, "forms.published")).orderBy(auditLog.id);
    expect(published).toBeTruthy();
    const all = await h.db.select().from(auditLog).where(eq(auditLog.entityId, d.formId));
    for (const a of [...saved, ...all]) {
      const text = JSON.stringify([a.oldValue, a.newValue]);
      expect(text).not.toContain("Voornaam");
      expect(text).not.toContain("fields");
    }
  });

  it("creates, updates and lists tracked links with their URL", async () => {
    const d = await draftWith(lead());
    const link = ok<{ linkId: string; key: string; url: string }>(await actions.createLink({ formId: d.formId, name: "Flyer Ghent station", channel: "print", utm: { campaign: "flyer" } }));
    expect(link.key).toMatchObject(/^[a-z0-9]{8}$/);
    expect(link.url).toBe(`https://app.example.com/nl/f/${d.slug}?l=${link.key}`);
    const upd = ok<{ key: string }>(await actions.updateLink({ linkId: link.linkId, isActive: false, name: "Flyer Ghent" }));
    expect(upd.key).toBe(link.key);
    const rows = await queries.listLinks(h.db, d.formId);
    expect(rows).toMatchObject([{ id: link.linkId, name: "Flyer Ghent", isActive: false, channel: "print", utm: { campaign: "flyer" }, starts: 0, completions: 0, url: link.url }]);
    const audits = await h.db.select().from(auditLog).where(eq(auditLog.entityId, link.linkId));
    expect(audits.map((a) => a.action).sort()).toEqual(["forms.link_created", "forms.link_updated"]);
    err(await actions.updateLink({ linkId: "00000000-0000-4000-8000-000000000000", isActive: true }), "not_found");
  });

  it("lists forms with their current version and draft flag, and compares versions", async () => {
    const d = await draftWith(lead());
    ok(await actions.publishVersion({ formId: d.formId, versionId: d.versionId, changeNote: "Go" }));
    const draft = ok<{ versionId: string }>(await actions.createDraft({ formId: d.formId }));
    const c = clone(lead());
    c.definition.title = T("Changed");
    ok(await actions.saveDraft({ formId: d.formId, versionId: draft.versionId, ...body(c), expectedHash: (await versionRow(draft.versionId)).definitionHash }));
    const list = await queries.listForms(h.db, { q: d.slug });
    expect(list).toMatchObject([{ id: d.formId, status: "published", currentVersion: 1, hasDraft: true, started30d: 0, completionRate: null }]);
    expect(await queries.listForms(h.db, { status: "archived", q: d.slug })).toEqual([]);
    const versions = await queries.listVersions(h.db, d.formId);
    expect(versions.map((v) => [v.version, v.isCurrent, !!v.publishedAt])).toEqual([
      [2, false, false],
      [1, true, true],
    ]);
    const diff = await queries.diffFormVersions(h.db, draft.versionId, d.versionId);
    expect(diff).toMatchObject({ from: { version: 1 }, to: { version: 2 }, form: ["title"], same: false });
  });
});
