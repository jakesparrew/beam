/**
 * forms-P8 (R2): the portal "My results" list, "View result" with a fresh result token,
 * cross-device resume for logged-in customers (U5) and the `webinar` CTA kind (P7, section 4
 * "CTA targets").
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { activityEvents, formSubmissions, webinars } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { Cta } from "@beam/core/forms";
import { and, eq, setAppDb, type Actor } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { GET as goRoute } from "@/app/api/public/forms/result/[token]/go/[ctaKey]/route";
import { assessment, ASSESSMENT_ANSWERS, createForm, later, lead, publicCtx, setupEnv } from "./forms-p3.fixtures";
import { checkCtaTargets, ctaProblem, isInternalCta, resolveCtaTarget } from "./service/cta-targets";
import { getResultByToken } from "./service/public-queries";
import { completeSubmission, featuredAssessment, listPortalResults, markAbandoned, openPortalResult, saveSection, startSubmission } from "./service/submissions";
import { createResultToken, verifyIdentityToken } from "./service/tokens";
import { nav } from "./nav";
import { flags } from "./config";
import { countLandingConversions } from "./api";

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

const T0 = new Date("2026-11-04T09:00:00Z");
const DAY = 86_400;
const URL0 = "https://app.example.com/nl/f/x";
let mail = 0;
const email = () => `portal-${++mail}-${randomUUID().slice(0, 6)}@example.com`;
const label = { "nl-BE": "Ga", "fr-BE": "Aller", en: "Go" };

type Customer = Extract<Actor, { kind: "customer" }>;
/** A person with an email and a customer session (a fresh `userId` stands for another device's session). */
async function customer(): Promise<{ personId: string; email: string; actor: () => Customer }> {
  const address = email();
  const p = await makePerson(h.db, { email: address, firstName: "Lotte" });
  return { personId: p.id, email: address, actor: () => ({ kind: "customer", userId: randomUUID(), personId: p.id }) };
}

async function start(slug: string, actor: Actor, at: Date = T0, locale: "nl-BE" | "fr-BE" | "en" = "nl-BE") {
  const ctx = publicCtx(h.db, at, actor);
  return startSubmission(ctx.tx, ctx, { slug, locale, url: URL0, ip: "203.0.113.9" });
}
async function save(submissionId: string, sectionKey: string, answers: Record<string, unknown>, actor: Actor, at: Date) {
  const ctx = publicCtx(h.db, at, actor);
  return saveSection(ctx.tx, ctx, { submissionId, proof: {}, sectionKey, answers: answers as never });
}
async function submit(submissionId: string, answers: Record<string, unknown>, actor: Actor, at: Date) {
  const ctx = publicCtx(h.db, at, actor);
  return completeSubmission(ctx.tx, ctx, { submissionId, proof: {}, answers: answers as never, ip: "203.0.113.9", userAgent: "vitest" });
}
async function openResult(submissionId: string, actor: Actor, at: Date) {
  const ctx = publicCtx(h.db, at, actor);
  return openPortalResult(ctx.tx, ctx, { submissionId });
}
const row = async (id: string) => (await h.db.select().from(formSubmissions).where(eq(formSubmissions.id, id)))[0]!;
const tokenOf = (url: string) => url.split("/r/")[1]!;

/** A completed assessment of `who` (session-identified), with optional CTAs on every ending. */
async function completed(who: Awaited<ReturnType<typeof customer>>, o: { ctas?: Cta[]; at?: Date; slug?: string } = {}) {
  let slug = o.slug;
  if (!slug) {
    const a = assessment();
    if (o.ctas) for (const e of a.definition.endings) e.ctas = o.ctas;
    slug = (await createForm(h.db, a)).slug;
  }
  const at = o.at ?? T0;
  const s = await start(slug, who.actor(), at);
  const r = await submit(s.submissionId, { ...ASSESSMENT_ANSWERS, email: who.email }, who.actor(), later(at, 30));
  return { slug, submissionId: s.submissionId, resultUrl: r.resultUrl! };
}

describe("portal list (/[locale]/account/results)", () => {
  it("shows only the actor's submissions, completed ones with their outcome and open ones to continue", async () => {
    const me = await customer();
    const other = await customer();
    const mine = await completed(me);
    await completed(other, { slug: mine.slug });
    const lf = await createForm(h.db, lead());
    const contact = await start(lf.slug, me.actor());
    await submit(contact.submissionId, { email: me.email, first_name: "Lotte", message: "Hallo" }, me.actor(), later(T0, 30));
    const openForm = await createForm(h.db, assessment());
    const open = await start(openForm.slug, me.actor(), later(T0, 60));

    const list = await listPortalResults(h.db, me.personId, later(T0, 120));
    const ids = [...list.completed, ...list.open].map((x) => x.submissionId);
    expect(ids).toEqual(expect.arrayContaining([mine.submissionId, contact.submissionId, open.submissionId]));
    expect(ids).toHaveLength(3);
    const minePortal = list.completed.find((c) => c.submissionId === mine.submissionId)!;
    expect(minePortal.hasResultPage).toBe(true);
    expect(minePortal.outcomeLabel).not.toBeNull();
    expect(list.completed.find((c) => c.submissionId === contact.submissionId)?.hasResultPage).toBe(false);
    expect(list.open).toEqual([expect.objectContaining({ submissionId: open.submissionId, formSlug: openForm.slug })]);
    // Never an answer value or a score on the portal rows.
    expect(JSON.stringify(list)).not.toContain("Lotte");
    expect(Object.keys(minePortal)).not.toContain("score");

    const theirs = await listPortalResults(h.db, other.personId, later(T0, 120));
    expect(theirs.completed.map((c) => c.submissionId)).not.toContain(mine.submissionId);
    expect(theirs.open).toEqual([]);
  });

  it("an open submission past its resume window, or of a form with resume off, is not offered", async () => {
    const me = await customer();
    const f = await createForm(h.db, assessment());
    await start(f.slug, me.actor());
    const off = await createForm(h.db, lead());
    await start(off.slug, me.actor());
    expect((await listPortalResults(h.db, me.personId, later(T0, 3600))).open.map((o) => o.formSlug)).toEqual([f.slug]);
    expect((await listPortalResults(h.db, me.personId, later(T0, 8 * DAY))).open).toEqual([]);
  });

  it("the empty state links to the newest published assessment of the locale", async () => {
    const f = await createForm(h.db, assessment());
    const featured = await featuredAssessment(h.db, "nl-BE");
    expect(featured?.slug).toBe(f.slug);
    const me = await customer();
    expect(await listPortalResults(h.db, me.personId, T0)).toEqual({ completed: [], open: [] });
  });

  it("declares the portal entry behind ff_forms_portal_results", () => {
    expect(flags.map((f) => f.key)).toContain("ff_forms_portal_results");
    expect(nav.find((n) => n.area === "portal" && n.href === "/account/results")).toMatchObject({ flag: "ff_forms_portal_results", labelKey: "forms.nav.my_results" });
  });
});

describe('"View result" issues a fresh token', () => {
  it("an expired link is replaced by a new token valid 180 days; the old one stays dead", async () => {
    const me = await customer();
    const c = await completed(me);
    const oldToken = tokenOf(c.resultUrl);
    const now = later(T0, 200 * DAY);
    expect(await getResultByToken(h.db, oldToken, now)).toMatchObject({ expired: true });

    const { url } = await openResult(c.submissionId, me.actor(), now);
    const fresh = tokenOf(url);
    expect(url.startsWith(`https://app.example.com/nl/f/${c.slug}/r/`)).toBe(true);
    expect(fresh).not.toBe(oldToken);
    expect(await getResultByToken(h.db, fresh, now)).toMatchObject({ submissionId: c.submissionId });
    expect(await getResultByToken(h.db, oldToken, now)).toBeNull();
    const r = await row(c.submissionId);
    expect(r.resultTokenVersion).toBe(2);
    expect(r.resultTokenExpiresAt!.getTime()).toBe(now.getTime() + 180 * DAY * 1000);
  });

  it("a valid link keeps its token (the result email still works) and lives 180 days from the click", async () => {
    const me = await customer();
    const c = await completed(me);
    const now = later(T0, 10 * DAY);
    const { url } = await openResult(c.submissionId, me.actor(), now);
    expect(tokenOf(url)).toBe(tokenOf(c.resultUrl));
    expect((await row(c.submissionId)).resultTokenExpiresAt!.getTime()).toBe(now.getTime() + 180 * DAY * 1000);
  });

  it("another person's, an open, a thank-you or a non-customer request answers not_found", async () => {
    const me = await customer();
    const other = await customer();
    const c = await completed(me);
    await expect(openResult(c.submissionId, other.actor(), T0)).rejects.toMatchObject({ code: "not_found" });
    await expect(openResult(c.submissionId, { kind: "public" }, T0)).rejects.toMatchObject({ code: "not_found" });
    const f = await createForm(h.db, assessment());
    const open = await start(f.slug, me.actor());
    await expect(openResult(open.submissionId, me.actor(), T0)).rejects.toMatchObject({ code: "not_found" });
    const lf = await createForm(h.db, lead());
    const contact = await start(lf.slug, me.actor());
    await submit(contact.submissionId, { email: me.email, first_name: "Lotte", message: "Hallo" }, me.actor(), later(T0, 30));
    await expect(openResult(contact.submissionId, me.actor(), later(T0, 60))).rejects.toMatchObject({ code: "not_found" });
    expect(createResultToken(c.submissionId, 1)).toBe(tokenOf(c.resultUrl));
  });
});

describe("U5 (R2): logged-in resume on any device", () => {
  it("a second session continues the same submission and completes it once", async () => {
    const me = await customer();
    const f = await createForm(h.db, assessment());
    const first = await start(f.slug, me.actor(), T0);
    const about = { email: me.email, first_name: "Lotte", birth_on: "", sensitive_consent: true, newsletter: false };
    await save(first.submissionId, "about", about, me.actor(), later(T0, 20));

    const second = await start(f.slug, me.actor(), later(T0, 3600), "fr-BE");
    expect(second.submissionId).toBe(first.submissionId);
    expect(second.resumeToken).toBeNull();
    expect(second.resumed?.answers).toMatchObject({ first_name: "Lotte" });
    expect(second.resumed?.currentSectionKey).toBe("sleep_stress");
    expect(await row(first.submissionId)).toMatchObject({ status: "partial", locale: "fr-BE" });

    const done = await submit(first.submissionId, { ...ASSESSMENT_ANSWERS, email: me.email }, me.actor(), later(T0, 3700));
    expect(done.resultUrl).toContain(`/fr/f/${f.slug}/r/`);
    const rows = await h.db.select().from(formSubmissions).where(and(eq(formSubmissions.formId, f.formId), eq(formSubmissions.personId, me.personId)));
    expect(rows.map((r) => r.status)).toEqual(["completed"]);
    const events = await h.db.select().from(activityEvents).where(and(eq(activityEvents.refType, "form_submission"), eq(activityEvents.refId, first.submissionId)));
    expect(events.filter((e) => e.kind === "form.started")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "form.completed")).toHaveLength(1);

    const again = await start(f.slug, me.actor(), later(T0, 3800));
    expect(again.submissionId).not.toBe(first.submissionId);
    expect(again.resumed).toBeUndefined();
  });

  it("an abandoned submission within resumeDays becomes partial again; past the window a new one starts", async () => {
    const me = await customer();
    const f = await createForm(h.db, assessment());
    const s = await start(f.slug, me.actor(), T0);
    const ctx = publicCtx(h.db, later(T0, 2 * DAY));
    await markAbandoned(ctx.tx, ctx, 1000);
    expect((await row(s.submissionId)).status).toBe("abandoned");
    const back = await start(f.slug, me.actor(), later(T0, 3 * DAY));
    expect(back.submissionId).toBe(s.submissionId);
    expect(await row(s.submissionId)).toMatchObject({ status: "partial", abandonedAt: null });

    const late = await start(f.slug, me.actor(), later(T0, 11 * DAY));
    expect(late.submissionId).not.toBe(s.submissionId);
  });

  it("a form with resume off, an anonymous visitor and another person each start a new submission", async () => {
    const me = await customer();
    const off = await createForm(h.db, lead());
    const a = await start(off.slug, me.actor(), T0);
    expect((await start(off.slug, me.actor(), later(T0, 60))).submissionId).not.toBe(a.submissionId);
    const f = await createForm(h.db, assessment());
    const mine = await start(f.slug, me.actor(), T0);
    expect((await start(f.slug, { kind: "public" }, later(T0, 60))).submissionId).not.toBe(mine.submissionId);
    const other = await customer();
    expect((await start(f.slug, other.actor(), later(T0, 60))).submissionId).not.toBe(mine.submissionId);
  });
});

describe("CTA kind webinar (R2)", () => {
  async function webinar(status: "published" | "live" | "ended" | "draft" | "cancelled" | "archived") {
    const owner = await makeUser(h.db);
    const [w] = await h.db
      .insert(webinars)
      .values({
        slug: `sleep-${randomUUID().slice(0, 8)}`,
        title: { "nl-BE": "Beter slapen", "fr-BE": "Mieux dormir", en: "Sleep better" },
        mode: "on_demand",
        status,
        recordingVideoId: "dQw4w9WgXcQ",
        ownerUserId: owner.id,
        createdByUserId: owner.id,
      })
      .returning();
    return w!;
  }
  const cta = (webinarId?: string): Cta => ({ key: "webinar", kind: "webinar", label, ...(webinarId ? { webinarId } : {}) });

  it("validates against an existing, linkable webinar", async () => {
    for (const s of ["published", "live", "ended"] as const) expect(await ctaProblem(h.db, cta((await webinar(s)).id))).toBeNull();
    for (const s of ["draft", "cancelled", "archived"] as const) expect(await ctaProblem(h.db, cta((await webinar(s)).id))).toBe("missing_webinar");
    expect(await ctaProblem(h.db, cta(randomUUID()))).toBe("missing_webinar");
    expect(await ctaProblem(h.db, cta())).toBe("missing_webinar");
    const draft = await webinar("draft");
    const def = assessment().definition;
    def.endings[0]!.ctas = [cta(draft.id)];
    expect(await checkCtaTargets(h.db, def)).toEqual([{ endingKey: def.endings[0]!.key, ctaKey: "webinar", reason: "missing_webinar" }]);
  });

  it("resolves to /<locale>/webinars/<slug>, an internal target", async () => {
    const w = await webinar("published");
    expect(await resolveCtaTarget(h.db, cta(w.id), "fr-BE")).toEqual({ url: `https://app.example.com/fr/webinars/${w.slug}`, fallback: false });
    expect(isInternalCta(cta(w.id))).toBe(true);
    const gone = await webinar("cancelled");
    expect(await resolveCtaTarget(h.db, cta(gone.id), "nl-BE")).toEqual({ url: "https://app.example.com/nl", fallback: true });
  });

  it("the go route redirects to the webinar page with the person's identity token", async () => {
    const w = await webinar("published");
    const me = await customer();
    const now = new Date();
    const c = await completed(me, { ctas: [cta(w.id)], at: later(now, -120) });
    const token = tokenOf(c.resultUrl);
    const res = await goRoute(new Request(`https://app.example.com/api/public/forms/result/${token}/go/webinar`, { headers: { "x-forwarded-for": "198.51.100.77" } }), {
      params: Promise.resolve({ token, ctaKey: "webinar" }),
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(`https://app.example.com/nl/webinars/${w.slug}`);
    expect(verifyIdentityToken(loc.searchParams.get("pt"))?.personId).toBe(me.personId);
    const [clicked] = await h.db
      .select()
      .from(activityEvents)
      .where(and(eq(activityEvents.refId, c.submissionId), eq(activityEvents.kind, "assessment.cta_clicked")));
    expect(clicked?.data).toMatchObject({ cta_kind: "webinar", target_id: w.id, fallback: false });
  });
});

describe("api stubs", () => {
  it("countLandingConversions keeps its typed signature (forms-P9 fills it)", async () => {
    const rows = await countLandingConversions(h.db, { from: T0, to: later(T0, DAY) });
    expect(Array.isArray(rows)).toBe(true);
  });
});
