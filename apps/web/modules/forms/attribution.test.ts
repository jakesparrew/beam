/**
 * forms-P9 (R3): referral and partner attribution, campaign attribution with cost per lead, the
 * marketing KPI view, contact forms into crm's unified inbox and `countLandingConversions` for
 * site insights. site's `readReferralCode` is mocked to its R3 contract (the `beam_ref` cookie)
 * and crm's person functions are wrapped with spies, so the tests stay true when site-P9 lands.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { adSpendDaily, bookings, companies, formLinks, formSubmissions, formViewsDaily, inboxThreads, persons, vFormCampaignAttribution, vFormKpisDaily } from "@beam/db/schema";
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
      spy.created.push({ email: input.email, acquisition: input.acquisition as Record<string, unknown> | undefined });
      return real.findOrCreatePersonByEmail(tx, ctx, input);
    }),
    fillAcquisitionIfEmpty: vi.fn(async (tx: never, ctx: never, personId: string, acquisition: Parameters<typeof CrmApi.fillAcquisitionIfEmpty>[3]) => {
      spy.filled.push({ personId, acquisition: acquisition as Record<string, unknown> });
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
  cookies: async () => {
    if (spy.cookieHeader === null) throw new Error("cookies() was called outside a request scope");
    const pairs = spy.cookieHeader.split(";").map((p) => p.trim().split("=") as [string, string]);
    return { get: (name: string) => {
      const hit = pairs.find(([k]) => k === name);
      return hit ? { value: hit[1] } : undefined;
    } };
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

const acquisitionOf = async (address: string) => (await h.db.select({ a: persons.acquisition }).from(persons).where(eq(persons.email, address)))[0]?.a as Record<string, unknown> | undefined;

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
});
