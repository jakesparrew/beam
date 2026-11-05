/**
 * fix-w22-site-wiring: the R2 and R3 pieces later site packages built beside the files they could
 * not edit, now wired in: the event page renders `EventFactsView` of `./event-facts` (ticket
 * types, lead window, waitlist, webinar link), the `webinar_signup` block renders webinar's
 * `WebinarSignup`, events listing rows show the lead window, `RenderData` carries the page kind
 * and the partner of a landing page (the form embed then needs no lookup), and the "Website"
 * section nav links to the insights page.
 */
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { companies, pageVersions } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import { formatDateTime, t, type Locale } from "@beam/core/i18n";
import type { Block } from "@beam/core/site";
import type { EventFacts, PublicEvent, ResolvedPage } from "../../queries/public";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.42" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("next/cache", () => ({ revalidateTag: () => undefined, unstable_cache: (fn: (...a: unknown[]) => unknown) => fn }));
vi.mock("@/modules/forms/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  FormEmbed: vi.fn((p: { slug: string }) => createElement("div", { "data-form-embed": p.slug })),
}));
vi.mock("@/modules/webinar/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  WebinarSignup: vi.fn((p: { webinarId: string; locale: Locale }) => createElement("div", { "data-webinar-signup": p.webinarId, "data-locale": p.locale })),
}));

const forms = await import("@/modules/forms/api");
const webinar = await import("@/modules/webinar/api");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const pagesActions = await import("../../actions/pages");
const partner = await import("../../actions/partner");
const { publishable, slug, staffSession } = await import("../../site-p3.fixtures");
const { getPageByPath } = await import("../../queries/public");
const { emptyRenderData, loadRenderData } = await import("../../server/render-data");
const { BlockRenderer } = await import("./block-renderer");
const { PageView } = await import("./page-view");
const { EventsListBlockView } = await import("./blocks/events-list");
const { SiteSectionNav } = await import("../admin/pages-table");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  jar.clear();
  vi.mocked(forms.FormEmbed).mockClear();
  await staffSession(h.db, jar, ["site.edit", "site.publish"]);
});

const NOW = new Date("2026-06-20T10:00:00.000Z");
const trFor = (locale: Locale) => (key: string, params?: Record<string, string | number | Date>) => t(locale, key, params);

function ok<T>(r: { ok: boolean; data?: T; error?: unknown }): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as T;
}

function pageOf(blocks: Block[], overrides: Partial<ResolvedPage> = {}): ResolvedPage {
  return {
    pageId: randomUUID(),
    kind: "event",
    slug: "breathwork",
    legalKey: null,
    sessionId: randomUUID(),
    versionId: randomUUID(),
    version: 1,
    locale: "en",
    path: "events/breathwork",
    title: "Breathwork evening",
    blocks,
    seo: null,
    excerpt: null,
    coverMediaId: null,
    routes: { en: "events/breathwork" },
    publishedAt: NOW.toISOString(),
    firstPublishedAt: null,
    isPreview: false,
    ...overrides,
  };
}

function facts(overrides: Partial<EventFacts> = {}): EventFacts {
  const sessionId = randomUUID();
  return {
    sessionId,
    title: "Breathwork evening",
    startsAt: "2026-07-10T17:00:00.000Z",
    endsAt: "2026-07-10T19:00:00.000Z",
    status: "open",
    location: "BEAM Gent",
    isMemberOnly: false,
    isLeadMagnet: false,
    priceCents: null,
    memberPriceCents: null,
    band: "available",
    bookHref: `/en/account/book/${sessionId}`,
    ticketTypes: [],
    priorityUntil: null,
    accessDependsOnViewer: false,
    isWebinar: false,
    webinar: null,
    ...overrides,
  };
}

const renderPage = (event: EventFacts) =>
  renderToStaticMarkup(createElement(PageView, { page: pageOf([]), data: { ...emptyRenderData("en", "/en/events/breathwork"), event }, tr: trFor("en"), now: NOW }));

describe("event page facts (EventFactsView of ./event-facts)", () => {
  it("lists the ticket types with their prices", () => {
    const html = renderPage(
      facts({
        ticketTypes: [
          { id: randomUUID(), name: "Standard", publicCents: 2500, memberCents: 2000, isMemberOnly: false, onSale: true, soldOut: false, salesStartAt: null },
        ],
      }),
    );
    expect(html).toContain("data-ticket-types");
    expect(html).toContain("Standard");
    expect(html).toContain("€25.00");
    expect(html).toContain('data-price="member"');
    expect(html).toContain('data-action="tickets"');
  });

  it("shows the lead window and Check your access, never a band or a booking button", () => {
    const until = "2026-06-25T16:00:00.000Z";
    const html = renderPage(facts({ isLeadMagnet: true, priorityUntil: until, accessDependsOnViewer: true }));
    expect(html).toContain("data-lead-window");
    expect(html).toContain(formatDateTime(until, "en", "long"));
    expect(html).toContain('data-action="check_access"');
    expect(html).not.toContain("data-band");
    expect(html).not.toContain('data-action="tickets"');
  });

  it("offers the waitlist for a full event and the webinar page for a webinar-linked one", () => {
    expect(renderPage(facts({ band: "full" }))).toContain('data-action="waitlist"');
    const web = renderPage(facts({ isWebinar: true, webinar: { href: "/en/webinars/breathing" } }));
    expect(web).toContain('data-action="webinar"');
    expect(web).toContain('href="/en/webinars/breathing"');
    expect(renderPage(facts({ isWebinar: true, webinar: null }))).not.toContain("data-action");
  });
});

describe("webinar_signup block", () => {
  it("renders webinar's WebinarSignup with the block's webinar and the page locale", () => {
    const webinarId = randomUUID();
    const block: Block = { id: randomUUID(), type: "webinar_signup", webinarId };
    const html = renderToStaticMarkup(createElement(BlockRenderer, { blocks: [block], ctx: { locale: "fr-BE", tr: trFor("fr-BE"), data: emptyRenderData("fr-BE", "/fr/webinaire") } }));
    expect(html).toContain(`data-webinar-signup="${webinarId}"`);
    expect(html).toContain('data-locale="fr-BE"');
    expect(vi.mocked(webinar.WebinarSignup)).toHaveBeenCalledWith(expect.objectContaining({ webinarId, locale: "fr-BE" }), undefined);
  });
});

describe("events_list rows", () => {
  it("show 'Priority access for new guests until <date>' only for an event in its lead window", () => {
    const until = "2026-06-25T16:00:00.000Z";
    const row = (over: Partial<PublicEvent>): PublicEvent => ({
      sessionId: randomUUID(),
      title: "Lead evening",
      startsAt: "2026-07-10T17:00:00.000Z",
      endsAt: "2026-07-10T19:00:00.000Z",
      status: "open",
      band: "available",
      isMemberOnly: false,
      isLeadMagnet: true,
      location: null,
      href: "/nl/evenementen/lead",
      bookHref: "/nl/account/book",
      priorityUntil: null,
      ...over,
    });
    const block: Extract<Block, { type: "events_list" }> = { id: randomUUID(), type: "events_list", limit: 6, showFull: true };
    const data = { ...emptyRenderData("nl-BE", "/nl/evenementen"), events: { [block.id]: { items: [row({ priorityUntil: until }), row({ isLeadMagnet: false })], page: 1, hasMore: false } } };
    const html = renderToStaticMarkup(createElement(EventsListBlockView, { block, ctx: { locale: "nl-BE", tr: trFor("nl-BE"), data } }));
    expect(html.match(/data-lead-window/g)).toHaveLength(1);
    expect(html).toContain(t("nl-BE", "site.blocks.events.priorityUntil", { date: formatDateTime(until, "nl-BE", "long") }));
  });
});

describe("RenderData carries the page kind and the landing partner", () => {
  async function publishedLanding() {
    const base = slug("lp");
    const created = ok(await pagesActions.createPage({ kind: "landing", slug: base, title: { "nl-BE": base }, locales: ["nl-BE"] }));
    const content = { ...publishable(base, ["nl-BE"]), excerpt: { "nl-BE": `Excerpt of ${base}` } };
    const [row] = await h.db.select().from(pageVersions).where(eq(pageVersions.id, created.versionId));
    const saved = ok(await pagesActions.saveDraft({ pageId: created.pageId, versionId: created.versionId, expectedUpdatedAt: row!.updatedAt.toISOString(), ...content }));
    ok(await pagesActions.publishVersion({ versionId: saved.versionId }));
    return { pageId: created.pageId, path: content.paths["nl-BE"] as string };
  }

  it("the resolved landing page and its render data name the partner; the embed receives it without a lookup", async () => {
    const landing = await publishedLanding();
    const [c] = await h.db.insert(companies).values({ name: `Partner ${randomUUID().slice(0, 6)}`, isPartner: true }).returning({ id: companies.id });
    ok(await partner.setPagePartner({ pageId: landing.pageId, companyId: c!.id }));
    const page = await getPageByPath("nl-BE", landing.path);
    expect(page).toMatchObject({ kind: "landing", partnerCompanyId: c!.id });
    const data = await loadRenderData(page!);
    expect(data).toMatchObject({ pageKind: "landing", partnerCompanyId: c!.id });

    const block: Block = { id: randomUUID(), type: "form_embed", formSlug: "contact" };
    renderToStaticMarkup(createElement(BlockRenderer, { blocks: [block], ctx: { locale: "nl-BE", tr: trFor("nl-BE"), data } }));
    expect(vi.mocked(forms.FormEmbed).mock.calls.at(-1)![0].context).toMatchObject({ partnerCompanyId: c!.id });
  });

  it("a page of another kind carries no partner, and hand-built render data knows no kind", async () => {
    const data = await loadRenderData(pageOf([], { kind: "standard", sessionId: null, partnerCompanyId: randomUUID() }));
    expect(data).toMatchObject({ pageKind: "standard", partnerCompanyId: null });
    expect(emptyRenderData("en", "/en")).toMatchObject({ pageKind: null, partnerCompanyId: null });
  });
});

describe("Website section nav", () => {
  it("links the WordPress import and the insights pages", () => {
    const L = { "nav.website": "Website", "nav.imports": "WordPress import", "nav.insights": "Insights" };
    const html = renderToStaticMarkup(createElement(SiteSectionNav, { L, current: "/admin/site/insights" }));
    expect(html).toContain('href="/admin/site/imports"');
    expect(html).toMatch(/href="\/admin\/site\/insights"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/admin\/site\/insights"/);
  });
});
