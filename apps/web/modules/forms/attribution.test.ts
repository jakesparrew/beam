/**
 * forms-P9 (R3): referral and partner attribution, campaign attribution with cost per lead, the
 * marketing KPI view, contact forms into crm's unified inbox and `countLandingConversions` for
 * site insights. site's `readReferralCode` is mocked to its R3 contract (the `beam_ref` cookie)
 * and crm's person functions are wrapped with spies, so the tests stay true when site-P9 lands.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { activityEvents, adSpendDaily, bookings, companies, formLinks, formSubmissions, formViewsDaily, inboxThreads, persons, vFormCampaignAttribution, vFormKpisDaily } from "@beam/db/schema";
import { createTestDb, makePerson, makeSession, makeUser } from "@beam/db/testing";
import { makeOrder } from "@beam/db/testing/commerce-factories";
import { ForbiddenError } from "@beam/core/errors";
import { and, eq, type Actor } from "@/lib/ctx";
import type * as CrmApi from "@/modules/crm/api";
import { resetRuntime } from "@/lib/testing";
import { createForm, later, lead, publicCtx, setupEnv } from "./forms-p3.fixtures";

type AcqCall = { email: string; acquisition: Record<string, unknown> | undefined };
const spy = vi.hoisted(() => ({ created: [] as AcqCall[], filled: [] as { personId: string; acquisition: Record<string, unknown> }[], cookieHeader: null as string | null }));

vi.mock("@/modules/crm/api", async (importOriginal) => {
  const real = await importOriginal<typeof CrmApi>();
  return {
    ...real,
    findOrCreatePersonByEmail: vi.fn(async (tx: never, ctx: never, input: Parameters<typeof CrmApi.findOrCreatePersonByEmail>[2]) => {
      spy.created.push({ email: input.email, acquisition: input.acquisition });
      return real.findOrCreatePersonByEmail(tx, ctx, input);
    }),
    fillAcquisitionIfEmpty: vi.fn(async (tx: never, ctx: never, personId: string, acquisition: Parameters<typeof CrmApi.fillAcquisitionIfEmpty>[3]) => {
      spy.filled.push({ personId, acquisition: acquisition });
      return real.fillAcquisitionIfEmpty(tx, ctx, personId, acquisition);
    }),
  };
});

// site rule 63 (R3): the code is the `beam_ref` cookie's value. Mocked to that contract.
vi.mock("@/modules/site/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readReferralCode: (c: { get(name: string): { value: string } | undefined }) => c.get("beam_ref")?.value ?? null,
}));

// `next/headers` outside Next: the jar of the request the test is serving, or no request at all.
vi.mock("next/headers", () => ({
  cookies: () => {
    if (spy.cookieHeader === null) return Promise.reject(new Error("cookies() was called outside a request scope"));
    const pairs = spy.cookieHeader.split(";").map((p) => p.trim().split("=") as [string, string]);
    return Promise.resolve({
      get: (name: string) => {
        const hit = pairs.find(([k]) => k === name);
        return hit ? { value: hit[1] } : undefined;
      },
    });
  },
}));

const { completeSubmission, referralCodeOf, startSubmission } = await import("./service/submissions");
const { signSubmissionId } = await import("./service/tokens");
const { countLandingConversions } = await import("./api");
const { getCampaignAttribution, getFormKpis, listAttributedLinkCounts, partnerLinkCounts, PARTNER_LINK_COLUMNS } = await import("./queries");
const { makeCtx } = await import("@/lib/testing");

let h: DbHandle;
let staffUserId: string;
beforeAll(async () => {
  setupEnv();
  h = await createTestDb();
  staffUserId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  spy.created = [];
  spy.filled = [];
  spy.cookieHeader = null;
});

const email = () => `attr-${randomUUID().slice(0, 8)}@example.com`;
const answersFor = (address: string, extra: Record<string, unknown> = {}) => ({ email: address, first_name: "Noor", newsletter: false, ...extra });

/** Start at `at` with `url`, submit 30 seconds later; returns the submission id. */
async function run(slug: string, o: { at: Date; url: string; answers: Record<string, unknown>; actor?: Actor; referralCode?: string | null }) {
  const s0 = publicCtx(h.db, o.at, o.actor);
  const s = await startSubmission(s0.tx, s0, { slug, locale: "nl-BE", url: o.url, ip: "203.0.113.7" });
  const c = publicCtx(h.db, later(o.at, 30), o.actor);
  await completeSubmission(c.tx, c, {
    submissionId: s.submissionId,
    proof: s.resumeToken ? { resumeToken: s.resumeToken } : { fsid: signSubmissionId(s.submissionId) },
    answers: o.answers as never,
    ip: "203.0.113.7",
    userAgent: "vitest",
    ...(o.referralCode !== undefined ? { referralCode: o.referralCode } : {}),
  });
  return s.submissionId;
}

async function makeLink(formId: string, o: { channel: "referral" | "partner" | "link"; name: string; referrerPersonId?: string; partnerCompanyId?: string; utm?: Record<string, string> }) {
  const key = randomUUID().replace(/-/g, "").slice(0, 8);
  const [row] = await h.db
    .insert(formLinks)
    .values({ formId, key, name: o.name, channel: o.channel, utm: o.utm ?? {}, referrerPersonId: o.referrerPersonId ?? null, partnerCompanyId: o.partnerCompanyId ?? null, createdByUserId: staffUserId })
    .returning();
  return row!;
}

const acquisitionOf = async (address: string) => (await h.db.select({ a: persons.acquisition }).from(persons).where(eq(persons.email, address)))[0]?.a;

describe("referral links (form_links.referrer_person_id)", () => {
  it("a referral link sets acquisition.referrer_person_id for a new person only", async () => {
    const f = await createForm(h.db, lead());
    const referrer = await makePerson(h.db, { email: email() });
    const link = await makeLink(f.formId, { channel: "referral", name: "Referral from a friend", referrerPersonId: referrer.id });
    const url = `https://app.example.com/nl/f/${f.slug}?l=${link.key}`;

    const fresh = email();
    await run(f.slug, { at: new Date("2026-11-02T09:00:00Z"), url, answers: answersFor(fresh), referralCode: null });
    expect(spy.created.at(-1)!.acquisition).toMatchObject({ source: "referral", referrer_person_id: referrer.id, form_slug: f.slug });
    expect(await acquisitionOf(fresh)).toMatchObject({ source: "referral", referrer_person_id: referrer.id });

    // An existing person with an empty acquisition gets the form's acquisition, never the referrer.
    const existing = await makePerson(h.db, { email: email() });
    await run(f.slug, { at: new Date("2026-11-02T10:00:00Z"), url, answers: answersFor(existing.email!), referralCode: null });
    const filled = spy.filled.find((x) => x.personId === existing.id);
    expect(filled?.acquisition).toBeDefined();
    expect(filled!.acquisition).not.toHaveProperty("referrer_person_id");
    expect(filled!.acquisition).not.toHaveProperty("referral_code");
    expect((await acquisitionOf(existing.email!))?.referrer_person_id).toBeUndefined();
  });
});

describe("beam_ref referral code (rule A1, cross-module D18)", () => {
  it("referralCodeOf reads the beam_ref cookie of the submit request through site.readReferralCode", () => {
    const req = new Request("https://app.example.com/api/public/forms/x/submit", { method: "POST", headers: { cookie: "fsid=abc; beam_ref=K7M2QX9P; other=1" } });
    expect(referralCodeOf(req)).toBe("K7M2QX9P");
    expect(referralCodeOf(new Request("https://app.example.com/api/public/forms/x/submit", { method: "POST" }))).toBeNull();
    // Anything crm would refuse never reaches it.
    expect(referralCodeOf(new Request("https://app.example.com/x", { headers: { cookie: "beam_ref=%3Cscript%3E" } }))).toBeNull();
  });

  it("a beam_ref cookie on the submit request reaches findOrCreatePersonByEmail as acquisition.referral_code for a new person only", async () => {
    const f = await createForm(h.db, lead());
    const url = `https://app.example.com/nl/f/${f.slug}`;
    const req = new Request(`https://app.example.com/api/public/forms/${f.slug}/submit`, { method: "POST", headers: { cookie: "beam_ref=K7M2QX9P" } });

    const fresh = email();
    await run(f.slug, { at: new Date("2026-11-02T11:00:00Z"), url, answers: answersFor(fresh), referralCode: referralCodeOf(req) });
    const call = spy.created.find((c) => c.email === fresh);
    expect(call?.acquisition).toMatchObject({ referral_code: "K7M2QX9P", form_slug: f.slug });

    const existing = await makePerson(h.db, { email: email() });
    await run(f.slug, { at: new Date("2026-11-02T12:00:00Z"), url, answers: answersFor(existing.email!), referralCode: referralCodeOf(req) });
    expect(spy.filled.find((x) => x.personId === existing.id)!.acquisition).not.toHaveProperty("referral_code");
  });

  it("without an explicit code the submit reads the cookie of the request being served (next/headers)", async () => {
    const f = await createForm(h.db, lead());
    spy.cookieHeader = "beam_ref=W4TR8NZ2";
    const fresh = email();
    await run(f.slug, { at: new Date("2026-11-02T13:00:00Z"), url: `https://app.example.com/nl/f/${f.slug}`, answers: answersFor(fresh) });
    expect(spy.created.find((c) => c.email === fresh)?.acquisition).toMatchObject({ referral_code: "W4TR8NZ2" });

    // Outside a request (a job, an import) there is no cookie and no code.
    spy.cookieHeader = null;
    const other = email();
    await run(f.slug, { at: new Date("2026-11-02T14:00:00Z"), url: `https://app.example.com/nl/f/${f.slug}`, answers: answersFor(other) });
    expect(spy.created.find((c) => c.email === other)?.acquisition).not.toHaveProperty("referral_code");
  });

  it("the submit route passes the beam_ref cookie of its request on to crm", async () => {
    const f = await createForm(h.db, lead());
    const { POST } = await import("@/app/api/public/forms/[slug]/submit/route");
    const s0 = publicCtx(h.db, new Date(Date.now() - 60_000));
    const s = await startSubmission(s0.tx, s0, { slug: f.slug, locale: "nl-BE", url: `https://app.example.com/nl/f/${f.slug}`, ip: "203.0.113.7" });
    const fresh = email();
    const cookie = `fsid=${signSubmissionId(s.submissionId)}; beam_ref=H3XK9WQ2`;
    spy.cookieHeader = cookie; // what `next/headers` sees while Next serves this request
    const res = await POST(
      new Request(`https://app.example.com/api/public/forms/${f.slug}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, "x-forwarded-for": "203.0.113.70" },
        body: JSON.stringify({ submissionId: s.submissionId, answers: answersFor(fresh) }),
      }),
      { params: Promise.resolve({ slug: f.slug }) },
    );
    expect(res.status).toBe(200);
    expect(spy.created.find((c) => c.email === fresh)?.acquisition).toMatchObject({ referral_code: "H3XK9WQ2" });
  });
});

describe("countLandingConversions (site insights)", () => {
  it("counts completed submissions and the persons they created per landing path and campaign, in [from, to)", async () => {
    const f = await createForm(h.db, lead());
    const day = (hour: number) => new Date(`2026-04-01T${String(hour).padStart(2, "0")}:00:00Z`);
    const recovery = "https://app.example.com/nl/herstel-p9?utm_source=facebook&utm_medium=paid_social&utm_campaign=Autumn-P9";
    await run(f.slug, { at: day(8), url: recovery, answers: answersFor(email()), referralCode: null });
    await run(f.slug, { at: day(9), url: recovery, answers: answersFor(email()), referralCode: null });
    const existing = await makePerson(h.db, { email: email() });
    await run(f.slug, { at: day(10), url: recovery, answers: answersFor(existing.email!), referralCode: null });
    await run(f.slug, { at: day(11), url: "https://app.example.com/nl/slaap-p9", answers: answersFor(email()), referralCode: null });
    // Outside the range: the next day.
    await run(f.slug, { at: new Date("2026-04-02T08:00:00Z"), url: recovery, answers: answersFor(email()), referralCode: null });
    // Started but never completed: not a conversion.
    const s0 = publicCtx(h.db, day(12));
    await startSubmission(s0.tx, s0, { slug: f.slug, locale: "nl-BE", url: recovery, ip: "203.0.113.7" });

    const rows = await countLandingConversions(h.db, { from: new Date("2026-04-01T00:00:00Z"), to: new Date("2026-04-02T00:00:00Z") });
    const mine = rows.filter((r) => r.landingPath.endsWith("-p9"));
    expect(mine).toEqual([
      { landingPath: "/nl/herstel-p9", utmCampaign: "autumn-p9", submissions: 3, newPersons: 2 },
      { landingPath: "/nl/slaap-p9", utmCampaign: null, submissions: 1, newPersons: 1 },
    ]);
  });
});

describe("campaign attribution and marketing KPIs", () => {
  const CAMPAIGN = `spring-p9-${randomUUID().slice(0, 6)}`;
  const at = new Date("2026-03-10T09:00:00Z");
  const DAY = 86_400_000;

  beforeAll(async () => {
    const f = await createForm(h.db, lead());
    const url = `https://app.example.com/nl/f/${f.slug}?utm_source=meta&utm_medium=paid_social&utm_campaign=${CAMPAIGN.toUpperCase()}`;
    const a = email();
    await run(f.slug, { at, url, answers: answersFor(a), referralCode: null });
    await run(f.slug, { at: later(at, 3600), url, answers: answersFor(email()), referralCode: null });
    const [pa] = await h.db.select().from(persons).where(eq(persons.email, a));
    // Person a books on day 5 and pays 45 EUR on day 3 (both within 30 days); a payment on day 40 does not count.
    const session = await makeSession(h.db);
    await h.db.insert(bookings).values({ sessionId: session.id, personId: pa!.id, status: "confirmed", paidWith: "free", source: "portal", createdAt: new Date(at.getTime() + 5 * DAY) });
    const order = (days: number, totalCents: number) =>
      makeOrder(h.db, { personId: pa!.id, channel: "portal", status: "paid", subtotalCents: totalCents, vatCents: 0, totalCents, paidAt: new Date(at.getTime() + days * DAY) });
    await order(3, 4500);
    await order(40, 9900);
    // One result CTA click that day.
    await h.db.insert(activityEvents).values({ kind: "assessment.cta_clicked", personId: pa!.id, occurredAt: later(at, 120), actor: { kind: "system", id: null }, refType: "form_submission", refId: randomUUID(), data: {} });
    // Spend: by campaign id on the day, by campaign name the next day, and a campaign forms never saw.
    const spend = (campaignExternalId: string, campaignName: string, dayOn: string, spendCents: number) =>
      h.db.insert(adSpendDaily).values({ platform: "meta", accountId: "act_1", campaignExternalId, campaignName, dayOn, spendCents, raw: {}, pulledAt: at });
    await spend(CAMPAIGN, "Spring campaign", "2026-03-10", 5000);
    await spend("120000123", ` ${CAMPAIGN.toUpperCase()} `, "2026-03-11", 1000);
    await spend("999", "Unrelated webinar ad", "2026-03-10", 7000);
  });

  it("v_form_campaign_attribution totals match the fixtures, cost per lead from summed spend and leads", async () => {
    const r = await getCampaignAttribution(h.db, { from: "2026-03-10", to: "2026-03-11" });
    const row = r.rows.find((x) => x.utmCampaign === CAMPAIGN);
    expect(row).toEqual({ utmCampaign: CAMPAIGN, leads: 2, completions: 2, bookings: 1, revenue30dCents: 4500, spendCents: 6000, costPerLeadCents: 3000 });
    expect(r.rows.some((x) => x.spendCents === 7000)).toBe(false);
    const days = await h.db.select().from(vFormCampaignAttribution).where(eq(vFormCampaignAttribution.utmCampaign, CAMPAIGN));
    expect(days.find((d) => d.dayOn === "2026-03-11")).toMatchObject({ leads: 0, spendCents: 1000, costPerLeadCents: null });
    expect(days.find((d) => d.dayOn === "2026-03-10")).toMatchObject({ leads: 2, spendCents: 5000, costPerLeadCents: 2500 });
  });

  it("v_form_kpis_daily: leads created by forms, completions, CTA clicks and 30-day conversions per Brussels day", async () => {
    const k = await getFormKpis(h.db, { from: "2026-03-10", to: "2026-03-10" });
    expect(k.totals).toMatchObject({ leads: 2, completions: 2, ctaClicks: 1, conversions: 1, bookings: 1, purchases: 1, revenue30dCents: 4500, conversionRate: 0.5 });
    expect(k.days.map((d) => d.dayOn)).toEqual(["2026-03-10"]);
    const [row] = await h.db.select().from(vFormKpisDaily).where(eq(vFormKpisDaily.dayOn, "2026-03-10"));
    expect(Object.keys(row!)).not.toContain("personId");
  });
});

describe("partner view of link counts (partner.own)", () => {
  const partnerActor = async (companyId: string): Promise<Actor> => {
    const person = await makePerson(h.db, { partnerCompanyId: companyId });
    const u = await makeUser(h.db, { roleKey: "external_partner", personId: person.id });
    return { kind: "staff", userId: u.id, roleKey: "external_partner", permissions: new Set(["partner.own"]) as never, mfaAt: new Date() };
  };
  const company = async (name: string) => (await h.db.insert(companies).values({ name, isPartner: true }).returning({ id: companies.id }))[0]!.id;

  it("a partner sees the counts of their own links only, and no person data", async () => {
    const mine = await company("Partner P9 A");
    const theirs = await company("Partner P9 B");
    const f = await createForm(h.db, lead());
    const own = await makeLink(f.formId, { channel: "partner", name: "Gym flyer", partnerCompanyId: mine });
    const other = await makeLink(f.formId, { channel: "partner", name: "Other partner", partnerCompanyId: theirs });
    const at = new Date("2026-05-04T09:00:00Z");
    await run(f.slug, { at, url: `https://app.example.com/nl/f/${f.slug}?l=${own.key}`, answers: answersFor(email()), referralCode: null });
    await run(f.slug, { at: later(at, 600), url: `https://app.example.com/nl/f/${f.slug}?l=${other.key}`, answers: answersFor(email()), referralCode: null });
    const s0 = publicCtx(h.db, later(at, 900));
    await startSubmission(s0.tx, s0, { slug: f.slug, locale: "nl-BE", url: `https://app.example.com/nl/f/${f.slug}?l=${own.key}`, ip: "203.0.113.7" });
    await h.db.insert(formViewsDaily).values({ formId: f.formId, dayOn: "2026-05-04", linkKey: own.key, locale: "nl-BE", views: 9 });

    const actor = await partnerActor(mine);
    const rows = await partnerLinkCounts(makeCtx(h.db, { actor }));
    expect(rows).toEqual([{ linkId: own.id, formSlug: f.slug, formName: expect.any(Object), name: "Gym flyer", channel: "partner", isActive: true, views: 9, starts: 2, completions: 1 }]);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual([...PARTNER_LINK_COLUMNS].sort());
    const json = JSON.stringify(rows);
    expect(json).not.toMatch(/@example\.com|personId|referrer|Noor/);

    // A partner without a company, and a customer, are refused.
    const loose = await makeUser(h.db, { roleKey: "external_partner" });
    const noCompany: Actor = { kind: "staff", userId: loose.id, roleKey: "external_partner", permissions: new Set(["partner.own"]) as never, mfaAt: new Date() };
    await expect(partnerLinkCounts(makeCtx(h.db, { actor: noCompany }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(partnerLinkCounts(makeCtx(h.db, { actor: { kind: "public" } }))).rejects.toBeInstanceOf(ForbiddenError);

    // Staff see every partner and referral link on the attribution screen, with the partner name.
    const all = await listAttributedLinkCounts(h.db, { companyId: null, range: { from: "2026-05-04", to: "2026-05-04" } });
    expect(all.filter((l) => l.linkId === own.id || l.linkId === other.id).map((l) => [l.partnerName, l.starts, l.completions])).toEqual([
      ["Partner P9 A", 2, 1],
      ["Partner P9 B", 1, 1],
    ]);
  });
});

describe("contact forms into the unified inbox", () => {
  it("a contact form submission opens one inbox thread, once per submission", async () => {
    const f = await createForm(h.db, lead({ createInboxThread: true }));
    const at = new Date("2026-06-01T09:00:00Z");
    const s0 = publicCtx(h.db, at);
    const s = await startSubmission(s0.tx, s0, { slug: f.slug, locale: "nl-BE", url: `https://app.example.com/nl/f/${f.slug}`, ip: "203.0.113.7" });
    const submit = async (seconds: number) => {
      const c = publicCtx(h.db, later(at, seconds));
      return completeSubmission(c.tx, c, { submissionId: s.submissionId, proof: { fsid: signSubmissionId(s.submissionId) }, answers: answersFor(email(), { message: "Hebben jullie plaats zaterdag?" }), ip: "203.0.113.7", userAgent: "vitest", referralCode: null });
    };
    await submit(30);
    await submit(90); // U7: a repeated submit answers the stored result
    const threads = await h.db.select().from(inboxThreads).where(eq(inboxThreads.externalThreadId, `form:${s.submissionId}`));
    expect(threads).toHaveLength(1);
    const [sub] = await h.db.select().from(formSubmissions).where(and(eq(formSubmissions.id, s.submissionId), eq(formSubmissions.status, "completed")));
    expect(threads[0]!.personId).toBe(sub!.personId);
  });
});
