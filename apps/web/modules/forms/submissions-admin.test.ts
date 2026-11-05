/**
 * forms-P6 staff screens and actions on submissions (forms spec sections 4 and 5, rules SE3, ID6,
 * ID8, ID10): list filters and keyset cursor, detail rendered against the pinned version, sensitive
 * reveal (permission and `sensitive.read`), result email resend (3 times, distinct keys), result
 * link revoke, delete (cascade, audited reason without answers), staff-assisted entry and the
 * public `requestResultLink`, plus the enter page's health declaration status.
 */
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, emailMessages, formSensitiveAnswers, formSubmissions, forms, formVersions, jobs, roles, type NewFormSubmissionRow } from "@beam/db/schema";
import { seedDefaults } from "@beam/db/seed";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { FormDefinition } from "@beam/core/forms";

const jar = new Map<string, string>();
const nav = vi.hoisted(() => ({ notFound: 0 }));
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.61" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    nav.notFound++;
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

const actions = await import("./actions");
const queries = await import("./queries");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { and, eq, setAppDb, sql } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { getResultByToken } = await import("./service/public-queries");
const { completeSubmission, startSubmission } = await import("./service/submissions");
const { createResultToken } = await import("./service/tokens");
const { assessment, ASSESSMENT_ANSWERS, createForm, intake, later, lead, publicCtx, setupEnv, T } = await import("./forms-p3.fixtures");

let h: DbHandle;

type Ok<X> = { ok: true; data: X };
function ok<X>(r: unknown): X {
  expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
  return (r as Ok<X>).data;
}
function err(r: unknown, code: string): { code: string; message: string } {
  expect(r, JSON.stringify(r)).toMatchObject({ ok: false, error: { code } });
  return (r as { error: { code: string; message: string } }).error;
}

/** Signs in a staff user of `roleKey` whose role holds exactly `permissions`. */
async function signIn(roleKey: "marketing" | "reception" | "management", permissions: string[]) {
  const user = await makeUser(h.db, { roleKey });
  await h.db.update(roles).set({ permissions }).where(eq(roles.key, roleKey));
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey, now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}
const STAFF = ["forms.write", "forms.publish", "persons.read"];

/** A completed assessment submission with sensitive answers, through the real pipeline. */
async function completedAssessment() {
  const f = await createForm(h.db, assessment());
  const t0 = new Date(Date.now() - 60_000);
  const ctx = publicCtx(h.db, t0);
  const s = await startSubmission(ctx.tx, ctx, { slug: f.slug, locale: "en", url: `https://app.example.com/en/f/${f.slug}`, ip: "203.0.113.5" });
  const email = `p6-${randomUUID().slice(0, 8)}@example.com`;
  const done = publicCtx(h.db, later(t0, 30));
  await completeSubmission(done.tx, done, { submissionId: s.submissionId, proof: { resumeToken: s.resumeToken! }, answers: { ...ASSESSMENT_ANSWERS, email }, ip: "203.0.113.5", userAgent: "vitest" });
  const [sub] = await h.db.select().from(formSubmissions).where(eq(formSubmissions.id, s.submissionId));
  return { f, sub: sub!, email };
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
beforeEach(() => {
  jar.clear();
});

describe("listSubmissions", () => {
  it("filters by status, source, outcome, funnel, dates and person, and pages with a keyset cursor", async () => {
    const f = await createForm(h.db, lead());
    const p = await makePerson(h.db, { email: `filter-${randomUUID().slice(0, 6)}@example.com`, firstName: "Marieke", lastName: "Claes" });
    const base = new Date("2026-10-01T10:00:00Z");
    const rows = Array.from({ length: 53 }, (_, i): NewFormSubmissionRow => {
      const completed = i % 3 === 0;
      return {
        formId: f.formId,
        formVersionId: f.versionId,
        funnel: i % 2 ? "form:lead" : "spring",
        locale: "en",
        source: i % 5 === 0 ? "qr_code" : "website",
        status: completed ? "completed" : "partial",
        completedAt: completed ? new Date(base.getTime() + i * 3_600_000 + 60_000) : null,
        outcomeKey: completed ? "good" : null,
        personId: i === 7 ? p.id : null,
        startedAt: new Date(base.getTime() + i * 3_600_000),
      };
    });
    // Two rows with the same started_at prove the id tie-break of the cursor.
    rows.push({ ...rows[52]!, funnel: "tie" });
    await h.db.insert(formSubmissions).values(rows);

    const first = await queries.listSubmissions(h.db, { formId: f.formId });
    expect(first.rows).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await queries.listSubmissions(h.db, { formId: f.formId, cursor: first.nextCursor! });
    expect(second.rows).toHaveLength(4);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(54);
    const starts = [...first.rows, ...second.rows].map((r) => r.startedAt.getTime());
    expect([...starts].sort((a, b) => b - a)).toEqual(starts);

    expect((await queries.listSubmissions(h.db, { formId: f.formId, status: "completed" })).rows.every((r) => r.status === "completed")).toBe(true);
    expect((await queries.listSubmissions(h.db, { formId: f.formId, status: "completed" })).rows).toHaveLength(18);
    expect((await queries.listSubmissions(h.db, { formId: f.formId, source: "qr_code" })).rows).toHaveLength(11);
    expect((await queries.listSubmissions(h.db, { formId: f.formId, outcomeKey: "good" })).rows).toHaveLength(18);
    expect((await queries.listSubmissions(h.db, { formId: f.formId, funnel: "tie" })).rows).toHaveLength(1);
    // Brussels days: 2026-10-01 10:00 UTC is 12:00 in Brussels; hours 0..13 fall on that day.
    expect((await queries.listSubmissions(h.db, { formId: f.formId, from: "2026-10-01", to: "2026-10-01" })).rows).toHaveLength(12);
    const byName = await queries.listSubmissions(h.db, { formId: f.formId, q: "marieke cl" });
    expect(byName.rows.map((r) => r.person?.id)).toEqual([p.id]);
    expect((await queries.listSubmissions(h.db, { formId: f.formId, q: p.email!.toUpperCase() })).rows).toHaveLength(1);
    expect((await queries.listSubmissions(h.db, { formId: f.formId, cursor: "not-a-cursor" })).rows).toHaveLength(50);
  });
});

describe("getSubmission", () => {
  it("renders the labels of the pinned version after a newer version changed the label", async () => {
    const content = lead();
    const f = await createForm(h.db, content);
    const [sub] = await h.db
      .insert(formSubmissions)
      .values({ formId: f.formId, formVersionId: f.versionId, funnel: "form:x", locale: "en", status: "partial", answers: { first_name: "Lotte" }, path: ["s1"] })
      .returning();
    const def2: FormDefinition = JSON.parse(JSON.stringify(content.definition)) as FormDefinition;
    def2.fields.first_name = { ...def2.fields.first_name!, label: T("Given name, version two") };
    const [v1] = await h.db.select().from(formVersions).where(eq(formVersions.id, f.versionId));
    const [v2] = await h.db
      .insert(formVersions)
      .values({ ...v1!, id: undefined, version: 2, definition: def2, definitionHash: "v2", publishedAt: new Date() })
      .returning();
    await h.db.update(forms).set({ currentVersionId: v2!.id }).where(eq(forms.id, f.formId));

    const d = (await queries.getSubmission(h.db, sub!.id, "en"))!;
    expect(d.version.version).toBe(1);
    const answer = d.sections.flatMap((s) => s.answers).find((a) => a.key === "first_name")!;
    expect(answer.label).toBe(content.definition.fields.first_name!.label.en);
    expect(answer.value).toBe("Lotte");
    expect(d.person).toBeNull();
    expect(await queries.getSubmission(h.db, randomUUID())).toBeNull();
  });

  it("counts sensitive answers without values and shows score, outcome and result email", async () => {
    const { sub } = await completedAssessment();
    const d = (await queries.getSubmission(h.db, sub.id, "en"))!;
    expect(d.sensitiveCount).toBeGreaterThan(0);
    const all = JSON.stringify(d);
    expect(all).not.toContain("5_6");
    const sensitiveAnswers = d.sections.flatMap((s) => s.answers).filter((a) => a.sensitive);
    expect(sensitiveAnswers.length).toBeGreaterThan(0);
    expect(sensitiveAnswers.every((a) => a.value === null)).toBe(true);
    expect(d.dimensions.find((x) => x.key === "sleep")).toMatchObject({ sensitive: true, value: null });
    expect(d.dimensions.find((x) => x.key === "habits")).toMatchObject({ sensitive: false });
    expect(d.resultEmail?.messageId).toBe(sub.resultEmailMessageId);
    expect(d.events.map((e) => e.kind)).toContain("form.completed");
  });
});

describe("revealSensitiveAnswers (SE3)", () => {
  it("needs persons.sensitive_read and writes sensitive.read with keys only", async () => {
    const { sub } = await completedAssessment();
    await signIn("marketing", STAFF);
    err(await actions.revealSensitiveAnswers({ submissionId: sub.id }), "forbidden");
    const before = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "sensitive.read"), eq(auditLog.personId, sub.personId!)));
    expect(before).toHaveLength(0);

    await signIn("management", [...STAFF, "persons.sensitive_read"]);
    const r = ok<{ answers: { fieldKey: string; label: string; value: string }[] }>(await actions.revealSensitiveAnswers({ submissionId: sub.id }));
    const sleep = r.answers.find((a) => a.fieldKey === "sleep_hours")!;
    const field = assessment().definition.fields.sleep_hours as Extract<FormDefinition["fields"][string], { type: "single_choice" }>;
    expect(Object.values(field.label)).toContain(sleep.label);
    expect(Object.values(field.options.find((o) => o.key === "5_6")!.label)).toContain(sleep.value); // the option label, not the key
    expect(r.answers.some((a) => a.fieldKey === "score:sleep")).toBe(true);
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "sensitive.read"), eq(auditLog.personId, sub.personId!)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.newValue).toMatchObject({ purpose: "staff_view", submission_ids: [sub.id] });
    expect(JSON.stringify(audits[0])).not.toContain(sleep.value);
  });
});

describe("resendResultEmail", () => {
  it("resends at most 3 times with distinct idempotency keys", async () => {
    const { sub } = await completedAssessment();
    await signIn("marketing", STAFF);
    const ids: string[] = [];
    for (let n = 1; n <= 3; n++) ids.push(ok<{ emailMessageId: string }>(await actions.resendResultEmail({ submissionId: sub.id })).emailMessageId);
    expect(new Set(ids).size).toBe(3);
    err(await actions.resendResultEmail({ submissionId: sub.id }), "conflict");
    const keys = (await h.db.select({ key: emailMessages.idempotencyKey }).from(emailMessages).where(sql`${emailMessages.idempotencyKey} like ${`form_result:${sub.id}:%`}`)).map((r) => r.key).sort();
    expect(keys).toEqual([`form_result:${sub.id}:email`, `form_result:${sub.id}:resend:1`, `form_result:${sub.id}:resend:2`, `form_result:${sub.id}:resend:3`]);
    const [after] = await h.db.select().from(formSubmissions).where(eq(formSubmissions.id, sub.id));
    expect(after!.resultEmailMessageId).toBe(ids[2]);
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "forms.result_resent"), eq(auditLog.entityId, sub.id)));
    expect(audits).toHaveLength(3);
  });

  it("is refused without forms.write", async () => {
    const { sub } = await completedAssessment();
    await signIn("reception", ["persons.read", "persons.write"]);
    err(await actions.resendResultEmail({ submissionId: sub.id }), "forbidden");
  });
});

describe("revokeResultLink (ID6)", () => {
  it("makes the old token unknown (404) and audits the version bump", async () => {
    const { sub } = await completedAssessment();
    const oldToken = createResultToken(sub.id, sub.resultTokenVersion);
    expect(await getResultByToken(h.db, oldToken)).toMatchObject({ submissionId: sub.id });
    await signIn("marketing", STAFF);
    ok(await actions.revokeResultLink({ submissionId: sub.id }));
    expect(await getResultByToken(h.db, oldToken)).toBeNull();
    const [row] = await h.db.select().from(formSubmissions).where(eq(formSubmissions.id, sub.id));
    expect(row!.resultTokenVersion).toBe(sub.resultTokenVersion + 1);
    expect(await getResultByToken(h.db, createResultToken(sub.id, row!.resultTokenVersion))).toMatchObject({ submissionId: sub.id });
    const [audit] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "forms.result_link_revoked"), eq(auditLog.entityId, sub.id)));
    expect(audit).toBeDefined();
  });
});

describe("deleteSubmission", () => {
  it("removes the submission and its sensitive rows and audits the reason without answers", async () => {
    const { sub, email } = await completedAssessment();
    expect((await h.db.select().from(formSensitiveAnswers).where(eq(formSensitiveAnswers.submissionId, sub.id))).length).toBeGreaterThan(0);
    await signIn("reception", ["persons.read", "persons.write", "forms.write"]);
    err(await actions.deleteSubmission({ submissionId: sub.id, reason: "test" }), "forbidden");
    await signIn("marketing", STAFF);
    err(await actions.deleteSubmission({ submissionId: sub.id, reason: "because" as "test" }), "validation");
    ok(await actions.deleteSubmission({ submissionId: sub.id, reason: "subject_request" }));
    expect(await h.db.select().from(formSubmissions).where(eq(formSubmissions.id, sub.id))).toHaveLength(0);
    expect(await h.db.select().from(formSensitiveAnswers).where(eq(formSensitiveAnswers.submissionId, sub.id))).toHaveLength(0);
    const [audit] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "forms.submission_deleted"), eq(auditLog.entityId, sub.id)));
    expect(audit!.newValue).toEqual({ reason: "subject_request" });
    const text = JSON.stringify(audit);
    for (const v of [email, "Lotte", "5_6", "rarely"]) expect(text).not.toContain(v);
    err(await actions.deleteSubmission({ submissionId: sub.id, reason: "spam" }), "not_found");
  });
});

describe("startStaffEntry (ID10)", () => {
  it("is allowed for reception (persons.write), denied without it, refused for a form without staffEntryAllowed, and audited", async () => {
    const f = await createForm(h.db, intake());
    const noStaff = await createForm(h.db, lead({ staffEntryAllowed: false }));
    const p = await makePerson(h.db, { locale: "en" });
    await signIn("marketing", STAFF);
    err(await actions.startStaffEntry({ formId: f.formId, personId: p.id }), "forbidden");
    const user = await signIn("reception", ["persons.read", "persons.write"]);
    const r = ok<{ url: string }>(await actions.startStaffEntry({ formId: f.formId, personId: p.id }));
    expect(new URL(r.url).pathname).toBe(`/en/f/${f.slug}`);
    expect(new URL(r.url).searchParams.get("pt")).toBeTruthy();
    err(await actions.startStaffEntry({ formId: noStaff.formId, personId: p.id }), "validation");
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "forms.staff_entry_started"), eq(auditLog.entityId, f.formId)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ personId: p.id, newValue: { formId: f.formId, personId: p.id } });
    expect(audits[0]!.actor).toMatchObject({ kind: "staff", id: user.id });
  });

  it("the enter page shows the health-declaration status from hasValidSubmission", async () => {
    const { default: EnterPage } = await import("../../app/(admin)/admin/forms/enter/page");
    const [hd] = await h.db.select().from(forms).where(eq(forms.slug, "health-declaration"));
    const p = await makePerson(h.db, { locale: "en", firstName: "Ilse" });
    await signIn("reception", ["persons.read", "persons.write"]);
    const missing = renderToStaticMarkup(await EnterPage({ searchParams: Promise.resolve({ personId: p.id }) }));
    expect(missing).toContain('data-health="missing"');

    // A completed health declaration on its (seeded draft) version 1 counts (any version, ID11).
    const [v] = await h.db.select().from(formVersions).where(eq(formVersions.formId, hd!.id));
    await h.db.insert(formSubmissions).values({ formId: hd!.id, formVersionId: v!.id, personId: p.id, funnel: "form:health-declaration", locale: "en", status: "completed", completedAt: new Date() });
    const valid = renderToStaticMarkup(await EnterPage({ searchParams: Promise.resolve({ personId: p.id }) }));
    expect(valid).toContain('data-health="valid"');
    expect(valid).toContain("Ilse");
  });
});

describe("requestResultLink (ID8)", () => {
  it("answers the same for known and unknown emails and sends at most 3 links per day", async () => {
    const { f, sub, email } = await completedAssessment();
    const known = await actions.requestResultLink({ slug: f.slug, email, locale: "en" });
    const unknown = await actions.requestResultLink({ slug: f.slug, email: "nobody@example.com", locale: "en" });
    const missingForm = await actions.requestResultLink({ slug: "no-such-form", email, locale: "en" });
    expect(known).toEqual({ ok: true, data: { ok: true } });
    expect(unknown).toEqual(known);
    expect(missingForm).toEqual(known);
    for (let i = 0; i < 4; i++) await actions.requestResultLink({ slug: f.slug, email, locale: "en" });
    const queued = await h.db.select({ key: jobs.idempotencyKey }).from(jobs).where(sql`${jobs.idempotencyKey} like ${`form_result_link:${sub.id}:%`}`);
    expect(queued.length).toBeGreaterThan(0);
    expect(queued.length).toBeLessThanOrEqual(3);
    expect(new Set(queued.map((q) => q.key)).size).toBe(queued.length);
  });
});
