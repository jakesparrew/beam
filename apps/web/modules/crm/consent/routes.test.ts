/**
 * crm-P3 public routes (crm spec 4.4, edge cases 6, 7, 26): the RFC 8058 one-click unsubscribe
 * and the token preference centre's JSON door, called as route handlers on a PGlite database.
 * email's `resolveLinkToken` and `sendTransactional` and automation's `requestSuppressionExit`
 * are mocked.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { consentRecords, consentWordings, persons, suppressions } from "@beam/db/schema";
import { emailHash, type MarketingPurpose } from "@beam/core/crm";
import type { Locale } from "@beam/core/i18n";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
process.env.AUTH_SECRET = "crm-p3-routes-secret";
process.env.APP_URL = "https://beam.example.com";

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined, delete: () => undefined }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.42" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
type Link = { emailMessageId: string; personId: string; purpose: MarketingPurpose | null; locale: Locale; sentAt: Date };
const mocks = vi.hoisted(() => ({
  links: new Map<string, Link>(),
  exits: [] as string[],
  sent: [] as { template: string; key: string; personId?: string }[],
}));
vi.mock("@/modules/email/api", () => ({
  resolveLinkToken: (_db: unknown, token: string) => Promise.resolve(mocks.links.get(token) ?? null),
  sendTransactional: (_ctx: unknown, input: { template: string; key: string; personId?: string }) => {
    mocks.sent.push(input);
    return Promise.resolve({ emailMessageId: randomUUID(), jobId: randomUUID() });
  },
}));
vi.mock("@/modules/automation/api", () => ({
  requestSuppressionExit: (_tx: unknown, input: { suppressionId: string }) => {
    mocks.exits.push(input.suppressionId);
    return Promise.resolve({ jobId: null });
  },
}));

const unsubscribeRoute = await import("@/app/api/public/unsubscribe/[token]/route");
const preferencesRoute = await import("@/app/api/public/preferences/[token]/route");
const api = await import("./api");
const { eq, setAppDb } = await import("@/lib/ctx");
const { makeCtx, resetRuntime } = await import("@/lib/testing");

let h: DbHandle;
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  for (const purpose of ["newsletter", "events", "member_comms", "b2b"] as const) {
    await h.db.insert(consentWordings).values({ purpose, version: 1, text: { en: purpose, "nl-BE": purpose, "fr-BE": purpose }, publishedAt: new Date("2026-01-01T00:00:00Z") });
  }
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  setAppDb(h.db);
  mocks.exits.length = 0;
  mocks.sent.length = 0;
});

const person = async (overrides: Parameters<typeof makePerson>[1] = {}) => {
  const email = `r-${randomUUID().slice(0, 8)}@example.com`;
  return makePerson(h.db, { email, emailHash: emailHash(email), firstName: "Lotte", ...overrides });
};
const subscribed = async (purposes: MarketingPurpose[] = ["newsletter"], overrides: Parameters<typeof makePerson>[1] = {}) => {
  const p = await person(overrides);
  for (const purpose of purposes) {
    await api.recordConsent(h.db as never, makeCtx(h.db), { personId: p.id, purpose, status: "granted", method: "portal", source: "portal", wordingVersion: `${purpose}@1`, recordedAt: new Date("2026-02-01T00:00:00Z") });
  }
  return p;
};
const link = (personId: string, purpose: MarketingPurpose | null, sentAt = new Date(), locale: Locale = "nl-BE") => {
  const token = `tok_${randomBytes(16).toString("hex")}`;
  const emailMessageId = randomUUID();
  mocks.links.set(token, { emailMessageId, personId, purpose, locale, sentAt });
  return { token, emailMessageId };
};
const params = (token: string) => ({ params: Promise.resolve({ token }) });
const post = (url: string, body: unknown) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const recordsOf = (personId: string) => h.db.select().from(consentRecords).where(eq(consentRecords.personId, personId));
const suppressionsOf = (email: string) => h.db.select().from(suppressions).where(eq(suppressions.emailHash, emailHash(email)));
const allOff = { newsletter: false, events: false, member_comms: false, b2b: false };

describe("one-click unsubscribe route", () => {
  it("POST answers 200 with an empty body and withdraws the message's purpose with source one_click:<message_id>", async () => {
    const p = await subscribed(["newsletter", "events"]);
    const { token, emailMessageId } = link(p.id, "newsletter");
    const res = await unsubscribeRoute.POST(new Request("https://beam.example.com/x", { method: "POST", body: "List-Unsubscribe=One-Click" }), params(token));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    const withdrawn = (await recordsOf(p.id)).filter((r) => r.status === "withdrawn");
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0]).toMatchObject({ purpose: "newsletter", method: "unsubscribe_link", source: `one_click:${emailMessageId}` });
    const [supp] = await suppressionsOf(p.email!);
    expect(supp).toMatchObject({ scope: "newsletter", reason: "unsubscribe", source: `one_click:${emailMessageId}` });
    expect(mocks.exits).toEqual([supp!.id]);
    const again = await unsubscribeRoute.POST(new Request("https://beam.example.com/x", { method: "POST" }), params(token));
    expect(again.status).toBe(200);
    expect(await suppressionsOf(p.email!)).toHaveLength(1);
  });

  it("GET never mutates and redirects 303 to the confirm page", async () => {
    const p = await subscribed();
    const { token } = link(p.id, "newsletter", new Date(), "fr-BE");
    const res = await unsubscribeRoute.GET(new Request("https://beam.example.com/x"), params(token));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`https://beam.example.com/fr/preferences/${token}?confirm=unsubscribe`);
    expect((await recordsOf(p.id)).filter((r) => r.status === "withdrawn")).toHaveLength(0);
    expect(await suppressionsOf(p.email!)).toHaveLength(0);
  });

  it("an unknown token answers 200 and writes nothing", async () => {
    const before = await h.db.select().from(suppressions);
    const res = await unsubscribeRoute.POST(new Request("https://beam.example.com/x", { method: "POST" }), params(`tok_${randomBytes(16).toString("hex")}`));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(await h.db.select().from(suppressions)).toHaveLength(before.length);
    expect(mocks.exits).toHaveLength(0);
  });

  it("edge case 7: a token of a merged person unsubscribes the winner", async () => {
    const winner = await subscribed(["events"]);
    const loser = await person({ mergedIntoPersonId: winner.id });
    const { token } = link(loser.id, "events");
    expect((await unsubscribeRoute.POST(new Request("https://beam.example.com/x", { method: "POST" }), params(token))).status).toBe(200);
    expect((await api.getCurrentConsents(h.db, winner.id)).events?.status).toBe("withdrawn");
    expect(await recordsOf(loser.id)).toHaveLength(0);
    expect(await api.isSuppressed(h.db, winner.email!, "events")).toBe(true);
  });
});

describe("preference centre route", () => {
  it("GET returns the state of the token's person and 404 for an unknown token", async () => {
    const p = await subscribed(["newsletter"], { locale: "en" });
    const { token } = link(p.id, "newsletter");
    const res = await preferencesRoute.GET(new Request("https://beam.example.com/x"), params(token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      firstNameInitial: "L",
      locale: "en",
      purposes: { newsletter: true, events: false, member_comms: false, b2b: false },
      suppressedAll: false,
      confirmPurpose: "newsletter",
      canEdit: true,
    });
    expect((await preferencesRoute.GET(new Request("https://beam.example.com/x"), params(`tok_${randomBytes(16).toString("hex")}`))).status).toBe(404);
  });

  it("POST saves the switches with method preference_centre and changes the language", async () => {
    const p = await subscribed(["newsletter"]);
    const { token } = link(p.id, null);
    const res = await preferencesRoute.POST(post("https://beam.example.com/x", { purposes: { ...allOff, events: true }, locale: "fr-BE" }), params(token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const current = await api.getCurrentConsents(h.db, p.id);
    expect(current.events).toMatchObject({ status: "granted", method: "preference_centre", source: "preference_centre", wordingVersion: "events@1" });
    expect(current.newsletter).toMatchObject({ status: "withdrawn", method: "preference_centre" });
    expect((await h.db.select().from(persons).where(eq(persons.id, p.id)))[0]!.locale).toBe("fr-BE");
  });

  it("edge case 26: a message older than 365 days still unsubscribes, but other changes get 410", async () => {
    const p = await subscribed(["newsletter", "b2b"]);
    const { token } = link(p.id, "newsletter", new Date(Date.now() - 400 * DAY));
    expect((await preferencesRoute.POST(post("https://beam.example.com/x", { purposes: { ...allOff, newsletter: true, b2b: true, events: true } }), params(token))).status).toBe(410);
    expect((await preferencesRoute.POST(post("https://beam.example.com/x", { purposes: { ...allOff, newsletter: true, b2b: true }, locale: "en" }), params(token))).status).toBe(410);
    expect((await api.getCurrentConsents(h.db, p.id)).events).toBeNull();
    const state = (await (await preferencesRoute.GET(new Request("https://beam.example.com/x"), params(token))).json()) as { canEdit: boolean };
    expect(state.canEdit).toBe(false);

    expect((await preferencesRoute.POST(post("https://beam.example.com/x", { purposes: { ...allOff, b2b: true } }), params(token))).status).toBe(200);
    expect((await api.getCurrentConsents(h.db, p.id)).newsletter?.status).toBe("withdrawn");
    expect((await unsubscribeRoute.POST(new Request("https://beam.example.com/x", { method: "POST" }), params(token))).status).toBe(200);
    expect((await preferencesRoute.POST(post("https://beam.example.com/x", { purposes: allOff, unsubscribeAll: true }), params(token))).status).toBe(200);
    expect(await api.isSuppressed(h.db, p.email!, "b2b")).toBe(true);
  });

  it("a fresh-link request sends crm.preference_link at most 3 times per person per day", async () => {
    const p = await subscribed();
    const { token } = link(p.id, "newsletter", new Date(Date.now() - 400 * DAY));
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await preferencesRoute.POST(post("https://beam.example.com/x", { freshLink: true }), params(token))).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(mocks.sent.map((s) => s.template)).toEqual(["crm.preference_link", "crm.preference_link", "crm.preference_link"]);
    expect(mocks.sent.map((s) => s.key.split(":").at(-1))).toEqual(["1", "2", "3"]);
    expect(mocks.sent.every((s) => s.personId === p.id && s.key.startsWith(`preference_link:${p.id}:`))).toBe(true);

    const unknown = `tok_${randomBytes(16).toString("hex")}`;
    const typed = await preferencesRoute.POST(post("https://beam.example.com/x", { freshLink: true, email: p.email }), params(unknown));
    const nobody = await preferencesRoute.POST(post("https://beam.example.com/x", { freshLink: true, email: "nobody-here@example.com" }), params(unknown));
    expect([typed.status, nobody.status]).toEqual([200, 200]);
    expect(await typed.json()).toEqual(await nobody.json());
    expect(mocks.sent).toHaveLength(3);
  });
});
