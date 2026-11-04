import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { activityEvents, pageRoutes, pages, pageVersions, termsAcceptances } from "@beam/db/schema";
import type { Locale } from "@beam/core/i18n";
import { CONSENT_COOKIE, encodeConsentCookie, paragraphDoc, type Block } from "@beam/core/site";
import type * as Navigation from "next/navigation";

const jar = new Map<string, string>();
const requestHeaders = new Map<string, string>([
  ["x-pathname", "/en/account"],
  ["x-nonce", "test-nonce"],
]);
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers([...requestHeaders.entries()])),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("next/cache", () => ({ unstable_cache: (fn: (...a: unknown[]) => unknown) => fn, revalidateTag: () => undefined, revalidatePath: () => undefined }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
}));
// next/script renders nothing on the server; make it visible so the markup shows what would load.
vi.mock("next/script", () => ({
  default: (props: { id?: string; src?: string; nonce?: string }) => createElement("script", { "data-script-id": props.id, "data-src": props.src, nonce: props.nonce }),
}));

const { and, eq, setAppDb } = await import("@/lib/ctx");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { resetRuntime } = await import("@/lib/testing");
const { acceptCurrentTerms } = await import("./portal");
const { getTermsBannerState } = await import("../queries/portal");
const { PortalSiteChrome } = await import("../ui/portal/site-chrome");
const { default: PortalLayout } = await import("@/app/[locale]/(portal)/account/layout");

let handle: DbHandle;
let termsPageId: string;
let clock = Date.now() - 60 * 60 * 1000;
const tick = () => new Date((clock += 1000));

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
  const [p] = await handle.db.insert(pages).values({ kind: "legal", legalKey: "terms", slug: "terms" }).returning();
  termsPageId = p!.id;
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(() => {
  jar.clear();
});

const legalBlocks = (body: string): Block[] => [{ id: crypto.randomUUID(), type: "rich_text", doc: paragraphDoc(body) }];

let versionNo = 0;
/** Publishes a new version of the terms page and returns its id. */
async function publishTerms(material: boolean): Promise<string> {
  versionNo += 1;
  const paths: Partial<Record<Locale, string>> = { "nl-BE": "voorwaarden", "fr-BE": "conditions", en: "terms" };
  const locales = Object.keys(paths) as Locale[];
  const [v] = await handle.db
    .insert(pageVersions)
    .values({
      pageId: termsPageId,
      version: versionNo,
      state: "published",
      publishedAt: tick(),
      title: Object.fromEntries(locales.map((l) => [l, `Terms ${l}`])),
      paths,
      blocks: Object.fromEntries(locales.map((l) => [l, legalBlocks(`Terms ${l} v${versionNo}`)])),
      locales,
      isMaterialChange: material,
    })
    .returning();
  await handle.db.update(pages).set({ status: "published", currentVersionId: v!.id }).where(eq(pages.id, termsPageId));
  await handle.db.delete(pageRoutes).where(eq(pageRoutes.pageId, termsPageId));
  for (const l of locales) await handle.db.insert(pageRoutes).values({ pageId: termsPageId, locale: l, path: paths[l]!, versionId: v!.id });
  return v!.id;
}

async function signInCustomer() {
  const user = await makeUser(handle.db, { audience: "customer" });
  const { token } = await createAuthSession(handle.db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
  jar.set(SESSION_COOKIE, token);
  return { userId: user.id, personId: user.personId! };
}

async function signInStaff() {
  const user = await makeUser(handle.db, { roleKey: "owner" });
  const { token } = await createAuthSession(handle.db, { userId: user.id, audience: "staff", roleKey: "owner", now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
}

const acceptances = (personId: string) =>
  handle.db.select().from(termsAcceptances).where(and(eq(termsAcceptances.personId, personId), eq(termsAcceptances.legalKey, "terms")));
const events = (personId: string) =>
  handle.db.select().from(activityEvents).where(and(eq(activityEvents.personId, personId), eq(activityEvents.kind, "site.terms_accepted")));

async function renderChrome(personId: string): Promise<string> {
  const el = await PortalSiteChrome({ locale: "en", personId, nonce: "test-nonce", children: createElement("div", { id: "shell-stand-in" }) });
  return renderToStaticMarkup(el);
}

describe("terms banner and portal chrome", () => {
  it("shows no banner while no material terms version exists", async () => {
    const { personId } = await signInCustomer();
    expect(await getTermsBannerState(personId)).toEqual({ show: false });
    await publishTerms(false);
    expect(await getTermsBannerState(personId)).toEqual({ show: false });
    const html = await renderChrome(personId);
    expect(html).not.toContain("data-terms-banner");
    expect(html).toContain('id="shell-stand-in"');
    expect(html).toContain("data-cookie-settings");
  });

  it("shows the banner after a material terms version until the customer accepts", async () => {
    const { personId } = await signInCustomer();
    const material = await publishTerms(true);
    const state = await getTermsBannerState(personId);
    expect(state).toMatchObject({ show: true, versionId: material });
    const html = await renderChrome(personId);
    expect(html).toContain("data-terms-banner");
    expect(html).toContain(`data-version-id="${material}"`);
    expect(html).toContain('href="/en/terms"');

    expect(await acceptCurrentTerms({ versionId: material })).toEqual({ ok: true, data: { ok: true } });
    expect(await getTermsBannerState(personId)).toEqual({ show: false });
    expect(await renderChrome(personId)).not.toContain("data-terms-banner");
  });

  it("loads no analytics script without analytics consent, and Vercel Analytics with the nonce after it", async () => {
    const { personId } = await signInCustomer();
    const without = await renderChrome(personId);
    expect(without).not.toContain("<script");
    jar.set(CONSENT_COOKIE, encodeConsentCookie({ k: crypto.randomUUID(), v: 0, a: false, m: false, t: Math.floor(Date.now() / 1000) }));
    expect(await renderChrome(personId)).not.toContain("<script");
    jar.set(CONSENT_COOKIE, encodeConsentCookie({ k: crypto.randomUUID(), v: 0, a: true, m: false, t: Math.floor(Date.now() / 1000) }));
    const withConsent = await renderChrome(personId);
    expect(withConsent).toContain('data-src="/_vercel/insights/script.js"');
    expect(withConsent).toContain('nonce="test-nonce"');
    expect(withConsent).not.toContain("googletagmanager");
  });
});

describe("acceptCurrentTerms", () => {
  it("writes one acceptance with context portal_prompt; a second call is a no-op", async () => {
    const versionId = await publishTerms(true);
    const { personId } = await signInCustomer();
    expect(await acceptCurrentTerms({ versionId })).toEqual({ ok: true, data: { ok: true } });
    expect(await acceptCurrentTerms({ versionId })).toEqual({ ok: true, data: { ok: true } });
    const rows = await acceptances(personId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pageVersionId: versionId, context: "portal_prompt", refType: null, refId: null });
    expect(await events(personId)).toHaveLength(1);
  });

  it("answers conflict for an old versionId and writes nothing", async () => {
    const old = await publishTerms(true);
    await publishTerms(true);
    const { personId } = await signInCustomer();
    const res = await acceptCurrentTerms({ versionId: old });
    expect(res).toMatchObject({ ok: false, error: { code: "conflict", message: "newer terms published, reload" } });
    expect(await acceptances(personId)).toHaveLength(0);
    expect(await events(personId)).toHaveLength(0);
  });

  it("refuses staff and anonymous visitors", async () => {
    const versionId = await publishTerms(false);
    expect(await acceptCurrentTerms({ versionId })).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    await signInStaff();
    expect(await acceptCurrentTerms({ versionId })).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });

  it("rejects an input without a version id", async () => {
    await signInCustomer();
    expect(await acceptCurrentTerms({})).toMatchObject({ ok: false, error: { code: "validation" } });
  });
});

describe("portal layout", () => {
  const params = Promise.resolve({ locale: "en" });
  const page = createElement("p", { id: "portal-page" }, "page");

  it("redirects an anonymous visitor to the sign-in page", async () => {
    const digest = await PortalLayout({ children: page, params }).then(
      () => null,
      (error: unknown) => (error as { digest?: string }).digest ?? null,
    );
    expect(digest).toMatch(/^NEXT_REDIRECT;.*\/en\/account\/login\?returnTo=%2Fen%2Faccount/);
  });

  it("renders PortalShell inside the site chrome for a customer", async () => {
    const { personId } = await signInCustomer();
    const el = (await PortalLayout({ children: page, params })) as ReactElement<Parameters<typeof PortalSiteChrome>[0]>;
    // The layout's root is the (async) chrome around PortalShell; render the chrome's output.
    expect(el.type).toBe(PortalSiteChrome);
    expect(el.props).toMatchObject({ locale: "en", personId, nonce: "test-nonce" });
    const html = renderToStaticMarkup(await PortalSiteChrome(el.props));
    expect(html).toContain('data-slot="portal-shell"');
    expect(html).toContain('id="portal-page"');
    expect(html).toContain("data-cookie-settings");
    expect(html).toContain('id="main-content"');
  });
});
