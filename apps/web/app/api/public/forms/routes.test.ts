/**
 * forms-P4: the public route handlers called with `new Request()` on `createTestDb()` (forms spec
 * section 4 "Route handlers", rules U1 to U7, R1 to R4, A1, ID7, E1, edge case 17).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { activityEvents, formSubmissions, formViewsDaily, persons } from "@beam/db/schema";
import { createTestDb, makeProduct } from "@beam/db/testing";
import type { Cta } from "@beam/core/forms";
import { and, eq, setAppDb } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { assessment, ASSESSMENT_ANSWERS, createForm, lead, setupEnv } from "@/modules/forms/forms-p3.fixtures";
import { createResultToken, signEmbedContext, verifyEmbedContext, verifyIdentityToken } from "@/modules/forms/service/tokens";
import { embedContextFor } from "@/modules/forms/ui/public/form-embed";
import { POST as viewRoute } from "./[slug]/view/route";
import { POST as startRoute } from "./[slug]/start/route";
import { GET as resumeRoute } from "./[slug]/resume/route";
import { POST as saveRoute } from "./[slug]/save/route";
import { POST as submitRoute } from "./[slug]/submit/route";
import { POST as viewedRoute } from "./result/[token]/viewed/route";
import { GET as goRoute } from "./result/[token]/go/[ctaKey]/route";
import { GET as embedJsRoute } from "./embed.js/route";

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

let ipN = 0;
const freshIp = () => `198.51.100.${++ipN % 250}`;
let mailN = 0;
const email = () => `route-${++mailN}-${randomUUID().slice(0, 6)}@example.com`;

type Opts = { ip?: string; cookie?: string };
function req(path: string, method: string, body?: unknown, o: Opts = {}): Request {
  const headers: Record<string, string> = { "x-forwarded-for": o.ip ?? freshIp(), "user-agent": "vitest" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (o.cookie) headers.cookie = o.cookie;
  return new Request(`https://app.example.com${path}`, { method, headers, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
}
const slugParams = (slug: string) => ({ params: Promise.resolve({ slug }) });
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

async function start(slug: string, body: Record<string, unknown> = {}, o: Opts = {}) {
  const res = await startRoute(req(`/api/public/forms/${slug}/start`, "POST", { locale: "nl-BE", url: `https://app.example.com/nl/f/${slug}?utm_source=facebook&utm_medium=paid_social`, ...body }, o), slugParams(slug));
  const setCookie = res.headers.get("set-cookie") ?? "";
  const data = await json(res);
  return { res, data, submissionId: data.submissionId as string, cookie: setCookie.split(";")[0] ?? "" };
}
/** R3: a real visitor needs at least 3 seconds; tests move `started_at` back instead of waiting. */
const age = (id: string) => h.db.update(formSubmissions).set({ startedAt: new Date(Date.now() - 60_000) }).where(eq(formSubmissions.id, id));
const submit = (slug: string, body: Record<string, unknown>, o: Opts = {}) => submitRoute(req(`/api/public/forms/${slug}/submit`, "POST", body, o), slugParams(slug));
const save = (slug: string, body: Record<string, unknown>, o: Opts = {}) => saveRoute(req(`/api/public/forms/${slug}/save`, "POST", body, o), slugParams(slug));
const row = async (id: string) => (await h.db.select().from(formSubmissions).where(eq(formSubmissions.id, id)))[0];
const eventsOf = (id: string, kind: string) =>
  h.db.select().from(activityEvents).where(and(eq(activityEvents.refType, "form_submission"), eq(activityEvents.refId, id), eq(activityEvents.kind, kind)));

describe("start -> save -> submit", () => {
  it("happy path on a lead form: fsid cookie, server next step, completed submission and person", async () => {
    const f = await createForm(h.db, lead());
    const s = await start(f.slug);
    expect(s.res.status).toBe(200);
    expect(s.res.headers.get("cache-control")).toBe("no-store");
    expect(s.submissionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.res.headers.get("set-cookie")).toMatch(/^fsid=[^;]+; Path=\/api\/public\/forms; Max-Age=86400; HttpOnly; Secure; SameSite=None$/);
    const addr = email();
    const answers = { email: addr, first_name: "Lotte", message: "Hello" };

    const saved = await save(f.slug, { submissionId: s.submissionId, sectionKey: "contact", answers }, { cookie: s.cookie });
    expect(saved.status).toBe(200);
    expect(await json(saved)).toEqual({ next: { end: true } });
    expect((await row(s.submissionId))?.status).toBe("partial");

    await age(s.submissionId);
    const done = await submit(f.slug, { submissionId: s.submissionId, answers }, { cookie: s.cookie });
    expect(done.status).toBe(200);
    const d = await json(done);
    expect(d).toMatchObject({ endingKey: expect.any(String), completedNow: true, pendingConfirmation: false });
    const r = await row(s.submissionId);
    expect(r).toMatchObject({ status: "completed", identifiedBy: "email", source: "paid_meta" });
    const [p] = await h.db.select().from(persons).where(eq(persons.id, r!.personId!));
    expect(p?.email).toBe(addr);

    // U7: a second submit answers the same ending and emits nothing new.
    const again = await json(await submit(f.slug, { submissionId: s.submissionId, answers }, { cookie: s.cookie }));
    expect(again).toMatchObject({ endingKey: d.endingKey, completedNow: false });
  });

  it("validation errors carry the field keys; a completed submission refuses a save with 409", async () => {
    const f = await createForm(h.db, lead());
    const s = await start(f.slug);
    const bad = await save(f.slug, { submissionId: s.submissionId, sectionKey: "contact", answers: { email: "not-an-email" } }, { cookie: s.cookie });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toMatchObject({ code: "validation", fields: { email: "invalid_email" } });
    await age(s.submissionId);
    await submit(f.slug, { submissionId: s.submissionId, answers: { email: email(), first_name: "Ann", message: "Hi" } }, { cookie: s.cookie });
    const late = await save(f.slug, { submissionId: s.submissionId, sectionKey: "contact", answers: { email: email() } }, { cookie: s.cookie });
    expect(late.status).toBe(409);
  });

  it("resume returns the open submission of a resume token, 404 for an unknown token", async () => {
    const f = await createForm(h.db, assessment());
    const s = await start(f.slug);
    const token = s.data.resumeToken as string;
    expect(token).toBeTruthy();
    const res = await resumeRoute(req(`/api/public/forms/${f.slug}/resume?token=${encodeURIComponent(token)}`, "GET"), slugParams(f.slug));
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ submissionId: s.submissionId, answers: {} });
    const unknown = await resumeRoute(req(`/api/public/forms/${f.slug}/resume?token=nope`, "GET"), slugParams(f.slug));
    expect(unknown.status).toBe(404);
  });
});

describe("refusals", () => {
  it("410 form_closed on an archived form", async () => {
    const f = await createForm(h.db, { ...lead(), status: "archived" });
    const s = await start(f.slug);
    expect(s.res.status).toBe(410);
    expect(s.data).toEqual({ ok: false, error: { code: "form_closed", message: "form_closed" } });
    const v = await viewRoute(req(`/api/public/forms/${f.slug}/view`, "POST", { locale: "nl-BE" }), slugParams(f.slug));
    expect(v.status).toBe(410);
  });

  it("404 without proof of ownership, and for another form's submission", async () => {
    const f = await createForm(h.db, lead());
    const other = await createForm(h.db, lead());
    const s = await start(f.slug);
    const answers = { email: email(), first_name: "X", message: "Y" };
    expect((await save(f.slug, { submissionId: s.submissionId, sectionKey: "contact", answers })).status).toBe(404);
    await age(s.submissionId);
    expect((await submit(f.slug, { submissionId: s.submissionId, answers })).status).toBe(404);
    expect((await submit(other.slug, { submissionId: s.submissionId, answers }, { cookie: s.cookie })).status).toBe(404);
    expect((await submit(f.slug, { submissionId: "not-a-uuid", answers }, { cookie: s.cookie })).status).toBe(404);
    expect((await row(s.submissionId))?.status).toBe("started");
  });

  it("404 for an unknown or unpublished form", async () => {
    const draft = await createForm(h.db, { ...lead(), status: "draft" });
    expect((await start(draft.slug)).res.status).toBe(404);
    expect((await start("no-such-form")).res.status).toBe(404);
  });

  it("413 above 64 KB", async () => {
    const f = await createForm(h.db, lead());
    const big = JSON.stringify({ locale: "nl-BE", url: "https://app.example.com/", pad: "x".repeat(70 * 1024) });
    const res = await startRoute(req(`/api/public/forms/${f.slug}/start`, "POST", big), slugParams(f.slug));
    expect(res.status).toBe(413);
  });

  it("429 rate_limited with retry-after once the per-IP forms bucket is full", async () => {
    const f = await createForm(h.db, lead());
    const ip = "192.0.2.77";
    // The bucket is a fixed one-minute window on the wall clock: freeze Date so the 22 requests
    // cannot straddle a minute boundary when the machine is slow (g111).
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-05T10:00:05Z") });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 21; i++) statuses.push((await viewRoute(req(`/api/public/forms/${f.slug}/view`, "POST", { locale: "nl-BE" }, { ip }), slugParams(f.slug))).status);
      expect(statuses.slice(0, 20).every((s) => s === 204)).toBe(true);
      const last = await viewRoute(req(`/api/public/forms/${f.slug}/view`, "POST", { locale: "nl-BE" }, { ip }), slugParams(f.slug));
      expect(last.status).toBe(429);
      expect(Number(last.headers.get("retry-after"))).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("R3: a honeypot answers 200 and writes nothing", async () => {
    const f = await createForm(h.db, lead());
    const bot = await start(f.slug, { honeypot: "https://spam.example.com" });
    expect(bot.res.status).toBe(200);
    expect(await row(bot.submissionId)).toBeUndefined();

    const s = await start(f.slug);
    await age(s.submissionId);
    const res = await submit(f.slug, { submissionId: s.submissionId, answers: { email: email(), first_name: "Bot", message: "Buy" }, honeypot: "filled" }, { cookie: s.cookie });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ completedNow: false });
    expect(await row(s.submissionId)).toMatchObject({ status: "started", personId: null });
  });

  it("R3: a submit within 3 seconds of start is dropped the same way", async () => {
    const f = await createForm(h.db, lead());
    const s = await start(f.slug);
    const res = await submit(f.slug, { submissionId: s.submissionId, answers: { email: email(), first_name: "Fast", message: "Hi" } }, { cookie: s.cookie });
    expect(res.status).toBe(200);
    expect((await row(s.submissionId))?.status).toBe("started");
  });
});

describe("view counter", () => {
  it("increments form_views_daily per day, link key and locale", async () => {
    const f = await createForm(h.db, lead());
    for (const linkKey of [undefined, "abc12345", "abc12345"]) {
      const res = await viewRoute(req(`/api/public/forms/${f.slug}/view`, "POST", { locale: "nl-BE", ...(linkKey ? { linkKey } : {}) }), slugParams(f.slug));
      expect(res.status).toBe(204);
    }
    const rows = await h.db.select().from(formViewsDaily).where(eq(formViewsDaily.formId, f.formId));
    expect(rows.map((r) => [r.linkKey, r.views]).sort()).toEqual([["", 1], ["abc12345", 2]]);
  });
});

describe("A1: embed context", () => {
  it("FormEmbed signs pagePath, referrer and partnerCompanyId; start stores landing_path from pagePath", async () => {
    const partnerCompanyId = randomUUID();
    const signed = embedContextFor({ pagePath: "/nl/herstel", referrer: "https://www.google.com/search", partnerCompanyId, utm: { campaign: "spring" } });
    expect(verifyEmbedContext(signed)).toEqual({ pagePath: "/nl/herstel", referrer: "https://www.google.com/search", partnerCompanyId, utm: { campaign: "spring" } });

    const f = await createForm(h.db, lead());
    const s = await start(f.slug, { url: `https://app.example.com/nl/herstel`, embedContext: signed });
    expect(await row(s.submissionId)).toMatchObject({ landingPath: "/nl/herstel", referrerUrl: "https://www.google.com/search", campaign: "spring", source: "organic_search" });
  });

  it("start with a forged embedContext ignores the context and its partner", async () => {
    const f = await createForm(h.db, lead());
    const real = signEmbedContext({ pagePath: "/nl/partner", partnerCompanyId: randomUUID(), utm: { source: "partner_site", medium: "b2b" } });
    const [body, sig] = real.split(".");
    const tampered = JSON.parse(Buffer.from(body!, "base64url").toString("utf8")) as Record<string, unknown>;
    tampered.partnerCompanyId = randomUUID();
    const forged = `${Buffer.from(JSON.stringify(tampered)).toString("base64url")}.${sig}`;
    expect(verifyEmbedContext(forged)).toBeNull();
    const s = await start(f.slug, { url: "https://app.example.com/nl/f/landing", embedContext: forged });
    const r = await row(s.submissionId);
    expect(r?.landingPath).toBe("/nl/f/landing");
    expect(r?.source).toBe("website");
    expect(r?.utm).toEqual({});
  });
});

describe("result routes", () => {
  async function completedAssessment(ctas: Cta[]) {
    const a = assessment();
    for (const e of a.definition.endings) e.ctas = ctas;
    const f = await createForm(h.db, a);
    const s = await start(f.slug);
    await age(s.submissionId);
    const res = await submit(f.slug, { submissionId: s.submissionId, answers: { ...ASSESSMENT_ANSWERS, email: email() } }, { cookie: s.cookie });
    expect(res.status).toBe(200);
    const sub = (await row(s.submissionId))!;
    return { slug: f.slug, submissionId: s.submissionId, personId: sub.personId!, token: createResultToken(sub.id, sub.resultTokenVersion), data: await json(res) };
  }
  const go = (token: string, ctaKey: string) => goRoute(req(`/api/public/forms/result/${token}/go/${ctaKey}`, "GET"), { params: Promise.resolve({ token, ctaKey }) });

  it("go/[ctaKey] redirects with pt and records assessment.cta_clicked once per day", async () => {
    const product = await makeProduct(h.db, { isActive: true });
    const r = await completedAssessment([{ key: "shop", kind: "product", productId: product.id, label: { "nl-BE": "Shop", "fr-BE": "Boutique", en: "Shop" } }]);
    expect(r.data.resultUrl).toBe(`https://app.example.com/nl/f/${r.slug}/r/${r.token}`);
    const res = await go(r.token, "shop");
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const loc = new URL(res.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe("https://app.example.com/nl/account/shop");
    expect(loc.searchParams.get("product")).toBe(product.id);
    expect(verifyIdentityToken(loc.searchParams.get("pt"))?.personId).toBe(r.personId);
    await go(r.token, "shop");
    const events = await eventsOf(r.submissionId, "assessment.cta_clicked");
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ cta_key: "shop", cta_kind: "product", target_id: product.id, fallback: false });
    expect((await go(r.token, "missing")).status).toBe(404);
    expect((await go("unknown-token", "shop")).status).toBe(404);
  });

  it("an inactive product falls back to the ending's url CTA with fallback = true", async () => {
    const product = await makeProduct(h.db, { isActive: false });
    const label = { "nl-BE": "Meer", "fr-BE": "Plus", en: "More" };
    const r = await completedAssessment([
      { key: "shop", kind: "product", productId: product.id, label },
      { key: "more", kind: "url", url: "https://www.example.com/more", label },
    ]);
    const res = await go(r.token, "shop");
    const loc = new URL(res.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe("https://www.example.com/more");
    expect(loc.searchParams.get("utm_source")).toBe("beam_form");
    expect(loc.searchParams.get("utm_campaign")).toBe(r.slug);
    expect(loc.searchParams.get("pt")).toBeNull();
    const [e] = await eventsOf(r.submissionId, "assessment.cta_clicked");
    expect(e?.data).toMatchObject({ cta_key: "shop", fallback: true });
  });

  it("result viewed records form.result_viewed once per day; unknown tokens answer 404", async () => {
    const r = await completedAssessment([]);
    const viewed = () => viewedRoute(req(`/api/public/forms/result/${r.token}/viewed`, "POST"), { params: Promise.resolve({ token: r.token }) });
    expect((await viewed()).status).toBe(204);
    expect((await viewed()).status).toBe(204);
    expect(await eventsOf(r.submissionId, "form.result_viewed")).toHaveLength(1);
    const unknown = await viewedRoute(req(`/api/public/forms/result/nope/viewed`, "POST"), { params: Promise.resolve({ token: "nope" }) });
    expect(unknown.status).toBe(404);
  });
});

describe("embed.js", () => {
  it("serves the script with a public one-hour cache", async () => {
    const res = embedJsRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    const body = await res.text();
    expect(body).toContain('"https://app.example.com"');
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(4096);
  });
});
