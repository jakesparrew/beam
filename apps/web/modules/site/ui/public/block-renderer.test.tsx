import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makeProduct } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { settings } from "@beam/db/schema";
import { t, type Locale } from "@beam/core/i18n";
import { companyFooter, paragraphDoc, type AvailabilityBand, type Block, type RichDoc } from "@beam/core/site";
import type { ResolvedPage } from "../../queries/public";
import type { RenderData } from "../../server/render-data";

vi.mock("next/cache", () => ({ unstable_cache: (fn: (...a: unknown[]) => unknown) => fn }));
vi.mock("@/modules/booking/api", () => ({
  listPublicEvents: vi.fn(),
  getAvailabilityPreview: vi.fn(),
  getAvailability: vi.fn(),
  getOpeningHours: vi.fn(),
}));
vi.mock("@/modules/commerce/api", () => ({ getProductPrice: vi.fn() }));
vi.mock("@/modules/forms/api", async () => {
  const { createElement } = await import("react");
  return { FormEmbed: vi.fn((p: { slug: string }) => createElement("div", { "data-form-embed": p.slug })) };
});

const booking = await import("@/modules/booking/api");
const commerce = await import("@/modules/commerce/api");
const forms = await import("@/modules/forms/api");
const { setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { emptyRenderData, loadRenderData } = await import("../../server/render-data");
const { BlockRenderer } = await import("./block-renderer");
const { PageView } = await import("./page-view");
const { CompanyFooter } = await import("./company-footer");
const { SiteFooter } = await import("./site-footer");


let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(() => {
  vi.mocked(booking.getOpeningHours).mockResolvedValue([]);
});

const id = () => randomUUID();
const trFor = (locale: Locale) => (key: string, params?: Record<string, string | number | Date>) => t(locale, key, params);

function pageOf(blocks: Block[], overrides: Partial<ResolvedPage> = {}): ResolvedPage {
  return {
    pageId: id(),
    kind: "standard",
    slug: "test",
    legalKey: null,
    sessionId: null,
    versionId: id(),
    version: 1,
    locale: "en",
    path: "prices",
    title: "Prices",
    blocks,
    seo: null,
    excerpt: null,
    coverMediaId: null,
    routes: { en: "prices" },
    publishedAt: new Date().toISOString(),
    firstPublishedAt: null,
    isPreview: false,
    ...overrides,
  };
}

function render(blocks: Block[], data: Partial<RenderData> = {}, locale: Locale = "en"): string {
  const full = { ...emptyRenderData(locale, "/en/prices"), ...data };
  return renderToStaticMarkup(<BlockRenderer blocks={blocks} ctx={{ locale, tr: trFor(locale), data: full }} />);
}

describe("headings and rich text", () => {
  it("renders exactly one h1: the hero heading when the hero comes first, else the title", () => {
    const hero: Block = { id: id(), type: "hero", heading: "Welcome to BEAM" };
    const text: Block = { id: id(), type: "rich_text", doc: { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Section" }] }] } };
    const withHero = renderToStaticMarkup(<PageView page={pageOf([hero, text])} data={emptyRenderData("en", "/en/prices")} tr={trFor("en")} />);
    expect(withHero.match(/<h1/g)).toHaveLength(1);
    expect(withHero).toMatch(/<h1[^>]*>Welcome to BEAM<\/h1>/);
    const withoutHero = renderToStaticMarkup(<PageView page={pageOf([text])} data={emptyRenderData("en", "/en/prices")} tr={trFor("en")} />);
    expect(withoutHero.match(/<h1/g)).toHaveLength(1);
    expect(withoutHero).toMatch(/<h1[^>]*>Prices<\/h1>/);
    expect(withoutHero).toContain("<h2>Section</h2>");
  });

  it("renders rich text as elements, never as raw HTML", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "<script>alert(1)</script><img src=x onerror=alert(1)>" }] },
        { type: "paragraph", content: [{ type: "text", text: "bad link", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] },
        { type: "paragraph", content: [{ type: "text", text: "good", marks: [{ type: "bold" }, { type: "link", attrs: { href: "https://example.com" } }] }] },
      ],
    } as RichDoc;
    const html = render([{ id: id(), type: "rich_text", doc }]);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('<a href="https://example.com" rel="noopener"');
  });
});

describe("video and testimonial", () => {
  it("renders the video facade with the poster and no iframe or Google URL before the click", () => {
    const poster = id();
    const html = render([{ id: id(), type: "video", youtubeId: "dQw4w9WgXcQ", title: "Tour of BEAM", posterMediaId: poster }], {
      media: { [poster]: { id: poster, url: "/api/public/files/f1", width: 1280, height: 720, alt: "Pool", decorative: false, caption: null } },
    });
    expect(html).not.toContain("<iframe");
    expect(html).not.toMatch(/youtube(-nocookie)?\.com|youtu\.be|google|ytimg/i);
    expect(html).toContain('aria-label="Play video: Tour of BEAM"');
    expect(html).toContain("/api/public/files/f1");
  });

  it("renders a testimonial with its author", () => {
    const html = render([{ id: id(), type: "testimonial", quote: "The best rest in town.", authorName: "Anna", authorDetail: "member since 2024", consentConfirmed: true }]);
    expect(html).toContain("The best rest in town.");
    expect(html).toContain("Anna");
    expect(html).toContain("member since 2024");
    expect(html).toContain("<blockquote");
  });
});

describe("pricing table", () => {
  it("shows the member line from a member price version and from member_discount_pct, and omits inactive products", async () => {
    const withMember = await makeProduct(handle.db, { sku: "PKG-MEMBER" });
    const withDiscount = await makeProduct(handle.db, { sku: "PKG-DISCOUNT", memberDiscountPct: "10.00" });
    const plain = await makeProduct(handle.db, { sku: "PKG-PLAIN" });
    const inactive = await makeProduct(handle.db, { sku: "PKG-OFF", isActive: false });
    const prices: Record<string, { public: number; member?: number }> = {
      [withMember.id]: { public: 25000, member: 20000 },
      [withDiscount.id]: { public: 3005 },
      [plain.id]: { public: 4500 },
      [inactive.id]: { public: 1000 },
    };
    vi.mocked(commerce.getProductPrice).mockImplementation((_db, productId, audience) => {
      const p = prices[productId];
      const amount = audience === "member" ? p?.member : p?.public;
      return Promise.resolve(amount === undefined ? null : { priceVersionId: id(), amountCents: amount });
    });
    const block: Block = { id: id(), type: "pricing_table", heading: "Packages", productIds: [withMember.id, withDiscount.id, plain.id, inactive.id], showMemberPrice: true };
    const data = await loadRenderData(pageOf([block]));
    const html = render([block], data);
    expect(html).toContain("€250.00");
    expect(html).toContain("Members: €200.00");
    // 3005 - round_half_up(300.5) = 3005 - 301 = 2704
    expect(html).toContain("Members: €27.04");
    expect(html).toContain("€45.00");
    expect(html.match(/data-price="member"/g)).toHaveLength(2);
    expect(html).not.toContain("PKG-OFF");
    expect(html).toContain("VAT included");
    expect(html).toContain('href="/en/checkout?sku=PKG-MEMBER&amp;from=%2Fen%2Fprices"');
    const hidden = render([{ ...block, showMemberPrice: false }], data);
    expect(hidden).not.toContain("Members:");
  });
});

describe("availability and events", () => {
  it("renders the preview bands of getAvailabilityPreview without numbers", async () => {
    const day = (h: number) => new Date(Date.now() + h * 3_600_000);
    vi.mocked(booking.getAvailabilityPreview).mockResolvedValue([
      { sessionId: id(), startsAt: day(24), band: "available" },
      { sessionId: id(), startsAt: day(48), band: "few" },
      { sessionId: id(), startsAt: day(72), band: "full" },
    ]);
    const block: Block = { id: id(), type: "availability_preview", kind: "night", days: 3 };
    const data = await loadRenderData(pageOf([block]));
    const call = vi.mocked(booking.getAvailabilityPreview).mock.calls.at(-1)![1];
    expect(call.kind).toBe("night");
    expect(call.to.getTime() - call.from.getTime()).toBe(3 * 86_400_000);
    const html = render([block], data);
    const bands = [...html.matchAll(/data-band="(\w+)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]);
    expect(bands).toEqual([
      ["available", "Available"],
      ["few", "Few places left"],
      ["full", "Full"],
    ]);
    expect(html).toContain('href="/en/account/book?kind=night"');
  });

  it("shows the empty state and pages listPublicEvents by limit", async () => {
    vi.mocked(booking.listPublicEvents).mockResolvedValueOnce([]);
    const block: Block = { id: id(), type: "events_list", heading: "Events", limit: 12, showFull: true };
    const empty = await loadRenderData(pageOf([block]));
    expect(render([block], empty)).toContain("No upcoming events at the moment.");

    const band = (i: number): AvailabilityBand => (i === 1 ? "few" : "available");
    const rows = Array.from({ length: 13 }, (_, i) => ({
      sessionId: id(),
      title: { en: `Event ${i + 1}`, "nl-BE": `Evenement ${i + 1}` },
      startsAt: new Date(Date.now() + (i + 1) * 86_400_000),
      endsAt: new Date(Date.now() + (i + 1) * 86_400_000 + 7_200_000),
      status: "open" as const,
      eventCategory: "lecture" as const,
      isMemberOnly: i === 0,
      isLeadMagnet: false,
      leadWindowEndAt: null,
      location: "Brussels",
      productId: null,
      availabilityBand: band(i),
    }));
    vi.mocked(booking.listPublicEvents).mockResolvedValueOnce(rows);
    const data = await loadRenderData(pageOf([block]), { page: "2" });
    expect(vi.mocked(booking.listPublicEvents).mock.calls.at(-1)![1]).toMatchObject({ limit: 13, offset: 12 });
    const html = render([block], data);
    expect(html.match(/<li/g)!.length).toBeGreaterThanOrEqual(12);
    expect(html).toContain("Event 1");
    expect(html).not.toContain("Event 13");
    expect(html).toContain("Members only");
    expect(html).toContain(`href="/en/account/book/${rows[0]!.sessionId}"`);
    expect(html).toContain('href="/en/prices?page=3"');
    expect(html).toContain('href="/en/prices?page=1"');
  });
});

describe("forms and booking entry points", () => {
  it("renders FormEmbed with the page path, landing path and UTM parameters", async () => {
    const block: Block = { id: id(), type: "form_embed", formSlug: "contact" };
    const data = await loadRenderData(pageOf([block], { path: "contact", locale: "nl-BE", routes: { "nl-BE": "contact" } }), { utm_source: "newsletter", utm_campaign: "spring" });
    const html = render([block], data, "nl-BE");
    expect(html).toContain('data-form-embed="contact"');
    expect(vi.mocked(forms.FormEmbed).mock.calls.at(-1)![0]).toEqual({
      slug: "contact",
      locale: "nl-BE",
      context: { pagePath: "/nl/contact", landingPath: "/nl/contact", utm: { source: "newsletter", campaign: "spring" } },
    });
  });

  it("links buy_product to the guest checkout with the page's own path and gift to /gift", async () => {
    const product = await makeProduct(handle.db, { sku: "GIFT-BUY" });
    const buy: Block = { id: id(), type: "booking_cta", label: "Buy now", target: { kind: "buy_product", productId: product.id } };
    const gift: Block = { id: id(), type: "booking_cta", label: "Give a voucher", target: { kind: "gift" } };
    const day: Block = { id: id(), type: "booking_cta", label: "Book a day", target: { kind: "book_day" } };
    const page = pageOf([buy, gift, day], { locale: "nl-BE", path: "aanbod/cadeau", routes: { "nl-BE": "aanbod/cadeau" } });
    const data = await loadRenderData(page);
    const html = render([buy, gift, day], data, "nl-BE");
    expect(html).toContain('href="/nl/checkout?sku=GIFT-BUY&amp;from=%2Fnl%2Faanbod%2Fcadeau"');
    expect(html).toContain('href="/nl/gift"');
    expect(html).toContain('href="/nl/account/book?kind=day"');
  });
});

describe("contact details and footer", () => {
  it("lists a holiday of the next 30 days and hides the hours when business_hours is empty", async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    vi.mocked(booking.getOpeningHours).mockResolvedValue([
      { onDate: tomorrow, opensAt: null, closesAt: null, exceptionName: { en: "Christmas", "nl-BE": "Kerstmis", "fr-BE": "Noël" } },
      { onDate: "2099-01-01", opensAt: "10:00", closesAt: "16:00", exceptionName: { en: "New Year" } },
      { onDate: "2099-01-02", opensAt: "08:30", closesAt: "19:00", exceptionName: null },
    ]);
    const block: Block = { id: id(), type: "contact_details", showAddress: true, showPhone: true, showEmail: true, showOpeningHours: true };
    const data = await loadRenderData(pageOf([block]));
    const html = render([block], data);
    expect(html).toContain("Opening hours");
    expect(html).toContain("Monday");
    expect(html).toContain("08:30-19:00");
    expect(html).toContain("Closed: Christmas");
    expect(html).toContain("New Year: 10:00-16:00");
    expect(html).toContain("support@demo.beam.be");
    const call = vi.mocked(booking.getOpeningHours).mock.calls.at(-1)![1];
    expect(Date.parse(`${call.to}T00:00:00Z`) - Date.parse(`${call.from}T00:00:00Z`)).toBe(30 * 86_400_000);

    await handle.db.insert(settings).values({ key: "business_hours", value: { week: { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null }, reception_phone: null, note: null } });
    const hidden = render([block], await loadRenderData(pageOf([block])));
    expect(hidden).not.toContain("Opening hours");
    expect(hidden).not.toContain("Christmas");
  });

  it("shows legal name, address, enterprise number and VAT in the footer", () => {
    const company = companyFooter({
      legal_name: "Vibrant Lifestyle Collective BV",
      trade_name: "BEAM Vitality Center",
      vat_number: "BE0123456789",
      enterprise_number: null,
      address: { street: "Teststraat 1", postal_code: "1000", city: "Brussel", country: "BE" },
      support_email: "support@demo.beam.be",
      phone: "+32 2 000 00 00",
    });
    const html = renderToStaticMarkup(<CompanyFooter company={company} tr={trFor("en")} />);
    expect(html).toContain("Vibrant Lifestyle Collective BV");
    expect(html).toContain("Teststraat 1");
    expect(html).toContain("1000 Brussel");
    expect(html).toContain("Enterprise number BE 0123.456.789");
    expect(html).toContain("VAT BE0123456789");
    const footer = renderToStaticMarkup(
      <SiteFooter locale="en" footer={[]} legal={[{ id: "l1", label: "Privacy", href: "/en/privacy", external: false, children: [] }]} company={{ ...company, social: [] }} tr={trFor("en")} pagePath="/en" />,
    );
    expect(footer).toContain("Vibrant Lifestyle Collective BV");
    expect(footer).toContain('href="/en/privacy"');
    expect(footer).toContain("Cookie settings");
    expect(footer).toContain('data-form-embed="newsletter"');
  });

  it("renders the legal meta line and paragraph docs", () => {
    const html = render(
      [
        { id: id(), type: "legal_meta" },
        { id: id(), type: "rich_text", doc: paragraphDoc("House rules apply.") },
      ],
      { legalMeta: { ordinal: 3, publishedAt: "2026-03-01T10:00:00.000Z" } },
    );
    expect(html).toContain("Version 3");
    expect(html).toContain("Last updated");
    expect(html).toContain("House rules apply.");
  });
});
