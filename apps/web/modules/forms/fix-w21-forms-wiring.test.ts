/**
 * fix-w21-forms-wiring: the forms rows of docs/build/requests.md that later forms packages could
 * not wire themselves. "View result" through `actions.ts` (forms-P8), the "Attribution" nav entry
 * and the overview links (forms-P6, forms-P9), the dashboard sources on `api.ts` (forms-P10) and the
 * submission's own partner from a signed embed context (forms-P3).
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { companies, formSubmissions, persons, roles } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.71" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

const actions = await import("./actions");
const api = await import("./api");
const dashboardSources = await import("./dashboard-sources");
const { nav } = await import("./nav");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { completeSubmission, startSubmission } = await import("./service/submissions");
const { signEmbedContext } = await import("./service/tokens");
const { assessment, ASSESSMENT_ANSWERS, createForm, later, lead, publicCtx, setupEnv } = await import("./forms-p3.fixtures");
const { default: FormOverviewPage } = await import("@/app/(admin)/admin/forms/[formId]/page");

let h: DbHandle;
beforeAll(async () => {
  setupEnv();
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => jar.clear());

let mail = 0;
const email = () => `w21-${++mail}-${randomUUID().slice(0, 6)}@example.com`;
const T0 = new Date(Date.now() - 120_000);

describe('"View result" through actions.ts (forms-P8 request)', () => {
  async function signInCustomer() {
    const address = email();
    const p = await makePerson(h.db, { email: address, firstName: "Lotte" });
    const user = await makeUser(h.db, { audience: "customer", email: address, personId: p.id });
    const { token } = await createAuthSession(h.db, { userId: user.id, audience: "customer", now: new Date() });
    jar.set(SESSION_COOKIE, token);
    return { personId: p.id, email: address };
  }

  it("openMyResult opens the signed-in customer's own completed result with a fresh token", async () => {
    const me = await signInCustomer();
    const f = await createForm(h.db, assessment());
    const actor = { kind: "customer" as const, userId: randomUUID(), personId: me.personId };
    const sctx = publicCtx(h.db, T0, actor);
    const s = await startSubmission(sctx.tx, sctx, { slug: f.slug, locale: "nl-BE", url: `https://app.example.com/nl/f/${f.slug}`, ip: "203.0.113.9" });
    const cctx = publicCtx(h.db, later(T0, 30), actor);
    await completeSubmission(cctx.tx, cctx, { submissionId: s.submissionId, proof: {}, answers: { ...ASSESSMENT_ANSWERS, email: me.email } as never, ip: "203.0.113.9", userAgent: "vitest" });

    const r = await actions.openMyResult({ submissionId: s.submissionId });
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    expect((r as { ok: true; data: { url: string } }).data.url).toContain(`/f/${f.slug}/r/`);

    const other = await actions.openMyResult({ submissionId: randomUUID() });
    expect(other).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("the portal results page imports openMyResult from actions.ts and declares no action of its own", () => {
    const src = readFileSync(new URL("../../app/[locale]/(portal)/account/results/page.tsx", import.meta.url), "utf8");
    expect(src).toContain('import { openMyResult } from "@/modules/forms/actions";');
    expect(src).not.toMatch(/\baction\(/);
    expect(src).not.toContain("openPortalResult");
  });
});

describe('the "Attribution" nav entry (forms-P9 request)', () => {
  it("links /admin/forms/attribution under Marketing with reports.read", () => {
    expect(nav.find((n) => n.key === "forms.attribution")).toMatchObject({
      area: "admin",
      section: "marketing",
      href: "/admin/forms/attribution",
      permission: "reports.read",
      labelKey: "forms.nav.attribution",
    });
  });
});

describe("dashboard sources on api.ts (forms-P10 request)", () => {
  it("re-exports FORMS_DASHBOARD_SOURCES and loadFormsDashboardSource unchanged", () => {
    expect(api.FORMS_DASHBOARD_SOURCES).toBe(dashboardSources.FORMS_DASHBOARD_SOURCES);
    expect(api.loadFormsDashboardSource).toBe(dashboardSources.loadFormsDashboardSource);
    expect(api.FORMS_DASHBOARD_SOURCE_KEYS).toEqual(["forms.funnel", "forms.outcomes", "forms.conversion"]);
    expect(api.isFormsDashboardSourceKey("forms.funnel")).toBe(true);
  });
});

describe("form overview links to submissions and report (forms-P6 request)", () => {
  async function signInStaff(permissions: string[]) {
    const user = await makeUser(h.db, { roleKey: "marketing" });
    await h.db.update(roles).set({ permissions }).where(eq(roles.key, "marketing"));
    const { token } = await createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey: "marketing", now: new Date(), mfaAt: new Date() });
    jar.set(SESSION_COOKIE, token);
  }

  it("shows the submissions link with persons.read and the report link to every forms.write user", async () => {
    const f = await createForm(h.db, lead());
    await signInStaff(["forms.write", "persons.read"]);
    const html = renderToStaticMarkup(await FormOverviewPage({ params: Promise.resolve({ formId: f.formId }) }));
    expect(html).toContain(`href="/admin/forms/${f.formId}/submissions"`);
    expect(html).toContain(`href="/admin/forms/${f.formId}/report"`);

    await signInStaff(["forms.write"]);
    const without = renderToStaticMarkup(await FormOverviewPage({ params: Promise.resolve({ formId: f.formId }) }));
    expect(without).not.toContain(`/admin/forms/${f.formId}/submissions`);
    expect(without).toContain(`href="/admin/forms/${f.formId}/report"`);
  });
});

describe("the submission's own partner (forms-P3 request, rule A1)", () => {
  const company = async () => (await h.db.insert(companies).values({ name: `Partner ${randomUUID().slice(0, 6)}`, isPartner: true }).returning({ id: companies.id }))[0]!.id;

  async function startWith(slug: string, embedContext: string) {
    const ctx = publicCtx(h.db, T0);
    return startSubmission(ctx.tx, ctx, { slug, locale: "nl-BE", url: `https://app.example.com/nl/partner`, ip: "203.0.113.11", embedContext, embedHost: "partner.example.com" });
  }
  const rowOf = async (id: string) => (await h.db.select().from(formSubmissions).where(eq(formSubmissions.id, id)))[0]!;

  it("a signed embed context's partner is stored and reaches the new person's acquisition", async () => {
    const partnerId = await company();
    const f = await createForm(h.db, lead());
    const s = await startWith(f.slug, signEmbedContext({ pagePath: "/nl/partner", partnerCompanyId: partnerId }));
    expect((await rowOf(s.submissionId)).partnerCompanyId).toBe(partnerId);

    const address = email();
    const ctx = publicCtx(h.db, later(T0, 30));
    await completeSubmission(ctx.tx, ctx, { submissionId: s.submissionId, proof: { resumeToken: s.resumeToken! }, answers: { email: address, first_name: "Lotte", message: "Hallo" } as never, ip: "203.0.113.11", userAgent: "vitest", referralCode: null });
    const [p] = await h.db.select().from(persons).where(eq(persons.email, address));
    expect(p?.acquisition).toMatchObject({ partner_company_id: partnerId, form_slug: f.slug });
  });

  it("a signed partner id of a company that no longer exists is dropped, not a failed start", async () => {
    const f = await createForm(h.db, lead());
    const s = await startWith(f.slug, signEmbedContext({ pagePath: "/nl/partner", partnerCompanyId: randomUUID() }));
    expect((await rowOf(s.submissionId)).partnerCompanyId).toBeNull();
  });

  it("without an embed context or link the submission has no partner", async () => {
    const f = await createForm(h.db, lead());
    const ctx = publicCtx(h.db, T0);
    const s = await startSubmission(ctx.tx, ctx, { slug: f.slug, locale: "nl-BE", url: `https://app.example.com/nl/f/${f.slug}`, ip: "203.0.113.12" });
    expect((await rowOf(s.submissionId)).partnerCompanyId).toBeNull();
  });
});
