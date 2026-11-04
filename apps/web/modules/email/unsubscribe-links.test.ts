/**
 * email-P4: crm's links in every message (email spec rules 2, 53, 55; decisions 22, 23, 55).
 * Marketing messages carry `List-Unsubscribe` with crm's one-click URL built from the message's
 * own link token and `List-Unsubscribe-Post`; transactional messages carry neither header and
 * only the preferences link; the footer links follow the message locale; crm's one-click route,
 * given the token read from the sent headers, resolves it through `resolveLinkToken` to the same
 * message and suppresses the person, after which `email.send` blocks the next marketing message.
 */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { createTestDb } from "@beam/db/testing";
import { consentWordings, suppressions } from "@beam/db/schema";
import { emailHash } from "@beam/core/crm";
import { hashLinkToken } from "@beam/core/email";
import { URL_SEGMENT, type Locale } from "@beam/core/i18n";
import { LIST_UNSUBSCRIBE_POST } from "@beam/email";

vi.hoisted(() => {
  process.env.SENSITIVE_DATA_KEY_V1 ??= Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  process.env.AUTH_SECRET = "email-p4-unsubscribe-links-secret";
});
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined, delete: () => undefined }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.44" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

const { eq, setAppDb } = await import("@/lib/ctx");
const { createFakeIntegrations, makeCtx, makeJobCtx, resetRuntime } = await import("@/lib/testing");
const { buildPreferenceUrls } = await import("@/modules/crm/api");
const unsubscribeRoute = await import("@/app/api/public/unsubscribe/[token]/route");
const { queueMarketingEmail, resolveLinkToken, sendTransactional, unsubscribeLinksFor } = await import("./api");
const { footerPreferenceUrls, linkTokenValues, listUnsubscribeOption, unsubscribeHeaders } = await import("./server/unsubscribe-links");
const { sendEmailMessage } = await import("./jobs");
const { blockTemplate, completeCompany, consent, messageOf, personWith, resetEmailTables } = await import("./email-p3.fixtures");

type Fakes = ReturnType<typeof createFakeIntegrations>;
let h: DbHandle;
let fakes: Fakes;
const LOCALES: readonly Locale[] = ["nl-BE", "fr-BE", "en"];

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  await completeCompany(h.db);
  for (const purpose of ["newsletter", "events", "member_comms", "b2b"] as const) {
    await h.db
      .insert(consentWordings)
      .values({ purpose, version: 1, text: { en: purpose, "nl-BE": purpose, "fr-BE": purpose }, publishedAt: new Date("2026-01-01T00:00:00Z") })
      .onConflictDoNothing();
  }
  await blockTemplate(h.db, { slug: "p4-links-news", kind: "marketing", purpose: "newsletter" });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  setAppDb(h.db);
  await resetEmailTables(h.db);
  fakes = createFakeIntegrations();
  vi.stubEnv("EMAIL_SINK", "");
  vi.stubEnv("APP_ENV", "local");
  vi.stubEnv("INTEGRATIONS", "fake");
  vi.stubEnv("APP_URL", "https://beam.be");
});
afterEach(() => vi.unstubAllEnvs());

const run = (emailMessageId: string, template: string) => sendEmailMessage(makeJobCtx(h.db, "email.send", { integrations: fakes }), { emailMessageId, template });
const magic = { url: "https://example.com/nl/account/login/verify?token=abc", expiresMinutes: 15 };
const tokenFromHeader = (header: string) => decodeURIComponent(/\/api\/public\/unsubscribe\/([^/>]+)>$/.exec(header)![1]!);
const tokenFromHtml = (html: string) => decodeURIComponent(/\/preferences\/([A-Za-z0-9_%-]+)/.exec(html)![1]!);

async function marketingMessage(key: string, locale: Locale = "nl-BE") {
  const p = await personWith(h.db, { firstName: "Femke", locale });
  await consent(h.db, p.id, "newsletter", "granted");
  const r = await queueMarketingEmail(makeCtx(h.db), { templateSlug: "p4-links-news", personId: p.id, enrolmentId: crypto.randomUUID(), idempotencyKey: key, context: {} });
  return { person: p, messageId: r.messageId };
}

describe("unsubscribeLinksFor (pure over crm's buildPreferenceUrls)", () => {
  const token = "p4TokenAbc_-123";

  it("marketing links carry crm's one-click URL, the confirm-unsubscribe page and the preference centre", () => {
    const crm = buildPreferenceUrls(token, "fr-BE");
    const links = unsubscribeLinksFor({ linkToken: token, kind: "marketing", locale: "fr-BE" });
    expect(links).toEqual({ listUnsubscribe: crm.oneClickPostUrl, unsubscribeUrl: crm.unsubscribeUrl, preferencesUrl: crm.preferencesUrl });
    expect(unsubscribeHeaders(links)).toEqual({ "List-Unsubscribe": `<${crm.oneClickPostUrl}>`, "List-Unsubscribe-Post": LIST_UNSUBSCRIBE_POST });
    expect(listUnsubscribeOption(links)).toEqual({ oneClickPostUrl: crm.oneClickPostUrl });
    expect(linkTokenValues(links)).toEqual({ preferences_url: crm.preferencesUrl, unsubscribe_url: crm.unsubscribeUrl });
  });

  it("transactional links carry no one-click URL, no unsubscribe link and only the preference centre", () => {
    const links = unsubscribeLinksFor({ linkToken: token, kind: "transactional", locale: "en" });
    expect(links).toEqual({ listUnsubscribe: null, unsubscribeUrl: null, preferencesUrl: buildPreferenceUrls(token, "en").preferencesUrl });
    expect(unsubscribeHeaders(links)).toEqual({});
    expect(listUnsubscribeOption(links)).toBeNull();
    expect(footerPreferenceUrls(links)).toEqual({ preferencesUrl: links.preferencesUrl, unsubscribeUrl: null });
    expect(linkTokenValues(links).unsubscribe_url).toBeNull();
  });

  it("the footer links follow the message locale and always use https on the public origin", () => {
    for (const locale of LOCALES) {
      const links = unsubscribeLinksFor({ linkToken: token, kind: "marketing", locale });
      expect(links.preferencesUrl).toBe(`https://beam.be/${URL_SEGMENT[locale]}/preferences/${token}`);
      expect(links.unsubscribeUrl).toBe(`https://beam.be/${URL_SEGMENT[locale]}/preferences/${token}?confirm=unsubscribe`);
      expect(links.listUnsubscribe).toBe(`https://beam.be/api/public/unsubscribe/${token}`);
    }
  });
});

describe("crm's links in sent messages", () => {
  it("a marketing message carries List-Unsubscribe built from its own link token, and the footer links of that token", async () => {
    const { messageId } = await marketingMessage("p4:mkt:headers", "fr-BE");
    expect(await run(messageId, "p4-links-news")).toMatchObject({ status: "sent" });
    const sent = fakes.resend.sent[0]!;
    const token = tokenFromHeader(sent.headers["List-Unsubscribe"]!);
    const m = await messageOf(h.db, messageId);
    expect(hashLinkToken(token)).toBe(m.linkTokenHash);
    const links = unsubscribeLinksFor({ linkToken: token, kind: "marketing", locale: "fr-BE" });
    expect(sent.headers).toMatchObject(unsubscribeHeaders(links));
    expect(sent.html).toContain(links.preferencesUrl);
    expect(sent.html).toContain(links.unsubscribeUrl!);
    expect(sent.text).toContain(links.preferencesUrl);
  });

  it("two marketing messages get two different tokens (one per message)", async () => {
    const a = await marketingMessage("p4:mkt:a");
    const b = await marketingMessage("p4:mkt:b");
    await run(a.messageId, "p4-links-news");
    await run(b.messageId, "p4-links-news");
    const [ha, hb] = fakes.resend.sent.map((s) => s.headers["List-Unsubscribe"]!);
    expect(ha).not.toBe(hb);
  });

  it("transactional messages carry neither header and only the preferences link, per locale", async () => {
    for (const locale of LOCALES) {
      const p = await personWith(h.db, { locale });
      const { emailMessageId } = await sendTransactional(makeCtx(h.db), { template: "platform.magic_link", personId: p.id, locale, data: magic, key: `p4:tx:${locale}` });
      expect(await run(emailMessageId, "platform.magic_link")).toMatchObject({ status: "sent" });
      const sent = fakes.resend.sent.at(-1)!;
      expect(sent.headers["List-Unsubscribe"]).toBeUndefined();
      expect(sent.headers["List-Unsubscribe-Post"]).toBeUndefined();
      const token = tokenFromHtml(sent.html);
      expect(hashLinkToken(token)).toBe((await messageOf(h.db, emailMessageId)).linkTokenHash);
      const links = unsubscribeLinksFor({ linkToken: token, kind: "transactional", locale });
      expect(links.preferencesUrl).toContain(`/${URL_SEGMENT[locale]}/preferences/`);
      expect(sent.html).toContain(links.preferencesUrl);
      expect(sent.html).not.toContain("/api/public/unsubscribe/");
      expect(sent.html).not.toContain("confirm=unsubscribe");
      expect(await resolveLinkToken(h.db, token)).toMatchObject({ emailMessageId, personId: p.id, purpose: null, locale });
    }
  });

  it("crm's one-click route, given the token from the sent headers, resolves it to the same message and suppresses the purpose", async () => {
    const { person, messageId } = await marketingMessage("p4:mkt:oneclick");
    await run(messageId, "p4-links-news");
    const header = fakes.resend.sent[0]!.headers["List-Unsubscribe"]!;
    const token = tokenFromHeader(header);
    expect(await resolveLinkToken(h.db, token)).toMatchObject({ emailMessageId: messageId, personId: person.id, purpose: "newsletter", locale: "nl-BE" });

    const url = header.slice(1, -1);
    const res = await unsubscribeRoute.POST(new Request(url, { method: "POST", body: "List-Unsubscribe=One-Click" }), { params: Promise.resolve({ token }) });
    expect(res.status).toBe(200);
    const rows = await h.db.select().from(suppressions).where(eq(suppressions.emailHash, emailHash(person.email!)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: "newsletter", reason: "unsubscribe", source: `one_click:${messageId}` });

    // The next marketing message to the person is blocked at send time (rule 40, rule 55).
    const next = await queueMarketingEmail(makeCtx(h.db), { templateSlug: "p4-links-news", personId: person.id, enrolmentId: crypto.randomUUID(), idempotencyKey: "p4:mkt:after", context: {} });
    if (next.status === "queued") expect(await run(next.messageId, "p4-links-news")).toMatchObject({ status: "suppressed" });
    else expect(next.status).toBe("skipped_unreachable");
    expect(fakes.resend.sent).toHaveLength(1);

    // A transactional message still goes out (scoped unsubscribe never blocks transactional mail).
    const tx = await sendTransactional(makeCtx(h.db), { template: "platform.magic_link", personId: person.id, locale: "nl-BE", data: magic, key: "p4:tx:after" });
    expect(await run(tx.emailMessageId, "platform.magic_link")).toMatchObject({ status: "sent" });
  });

  it("a transactional token on the one-click route writes nothing (no purpose to withdraw)", async () => {
    const p = await personWith(h.db);
    await consent(h.db, p.id, "newsletter", "granted");
    const { emailMessageId } = await sendTransactional(makeCtx(h.db), { template: "platform.magic_link", personId: p.id, locale: "en", data: magic, key: "p4:tx:oneclick" });
    await run(emailMessageId, "platform.magic_link");
    const token = tokenFromHtml(fakes.resend.sent[0]!.html);
    const res = await unsubscribeRoute.POST(new Request(`https://beam.be/api/public/unsubscribe/${token}`, { method: "POST" }), { params: Promise.resolve({ token }) });
    expect(res.status).toBe(200);
    expect(await h.db.select().from(suppressions).where(eq(suppressions.emailHash, emailHash(p.email!)))).toHaveLength(0);
  });

  it("a forged token resolves to nothing and the route writes nothing", async () => {
    const token = randomBytes(32).toString("base64url");
    expect(await resolveLinkToken(h.db, token)).toBeNull();
    const before = (await h.db.select().from(suppressions)).length;
    const res = await unsubscribeRoute.POST(new Request(`https://beam.be/api/public/unsubscribe/${token}`, { method: "POST" }), { params: Promise.resolve({ token }) });
    expect(res.status).toBe(200);
    expect(await h.db.select().from(suppressions)).toHaveLength(before);
  });
});
