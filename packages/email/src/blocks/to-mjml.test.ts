import { describe, expect, it } from "vitest";
import type { Block, BlockDocument } from "@beam/core/email";
import { buildFooter, DEFAULT_FOOTER_SETTINGS } from "../layout/footer";
import { compileMarketing, CompileError, mjmlToHtml } from "./compile";
import { blocksToMjml, cardRefs, type ResolvedCards } from "./to-mjml";

const PRODUCT = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const FILE = "33333333-3333-4333-8333-333333333333";

const COMPANY = {
  legal_name: "Vibrant Lifestyle Collective BV",
  trade_name: "BEAM Vitality Center",
  vat_number: "BE0123456789",
  address: { street: "Voorbeeldstraat 1", postal_code: "9000", city: "Gent", country: "BE" },
  support_email: "support@demo.beam.be",
};
const footer = buildFooter({
  company: COMPANY,
  footerSettings: DEFAULT_FOOTER_SETTINGS,
  legalLinks: { privacy: "https://beam.be/en/privacy", terms: "https://beam.be/en/terms" },
  purpose: "newsletter",
  locale: "en",
});

const CARDS: ResolvedCards = {
  products: { [PRODUCT]: { id: PRODUCT, name: "Ten-session card", sku: "CARD-10", priceCents: 19900, active: true } },
  events: { [SESSION]: { id: SESSION, title: "Breathwork evening", startsAt: "2026-12-03T18:30:00.000Z", url: "https://beam.be/en/events/breathwork", active: true } },
};

const ALL_BLOCKS: Block[] = [
  { id: "hd00000001", type: "heading", level: 1, text: "Hello {{first_name|friend}}" },
  { id: "tx00000001", type: "text", markdown: "Our **winter** programme is *here*.\n\n- Yoga\n- Sauna\n\n1. Book\n2. Enjoy\n\nRead [the full programme](https://beam.be/en/programme)." },
  { id: "im00000001", type: "image", fileId: FILE, alt: "The relaxation room", width: 560, href: "https://beam.be/en" },
  { id: "bt00000001", type: "button", label: "Book your session", href: "https://beam.be/en/book", style: "primary" },
  { id: "bt00000002", type: "button", label: "See your portal", href: "{{portal_url}}", style: "secondary" },
  { id: "dv00000001", type: "divider" },
  { id: "sp00000001", type: "spacer", height: 24 },
  { id: "pr00000001", type: "product", productId: PRODUCT, showPrice: true, ctaLabel: "Buy the card" },
  { id: "ev00000001", type: "event", sessionId: SESSION, ctaLabel: "Reserve a seat" },
  {
    id: "co00000001",
    type: "columns",
    stackOnMobile: true,
    columns: [
      { width: 50, blocks: [{ id: "tx00000002", type: "text", markdown: "Left column text." }] },
      { width: 50, blocks: [{ id: "tx00000003", type: "text", markdown: "Right column text." }] },
    ],
  },
  {
    id: "dy00000001",
    type: "dynamic",
    variants: [{ when: { status: "member" }, blocks: [{ id: "tx00000004", type: "text", markdown: "Thanks for being a member." }] }],
    fallback: [{ id: "tx00000005", type: "text", markdown: "Become a member." }],
  },
];

const doc = (blocks: Block[]): BlockDocument => ({ schemaVersion: 1, locales: { en: blocks } });

describe("blocksToMjml", () => {
  it("compiles every block type with validationLevel strict", async () => {
    const result = await compileMarketing(doc(ALL_BLOCKS), "en", { footer, resolveCards: () => CARDS });
    expect(Object.keys(result.variants).sort()).toEqual(["dy00000001:0", "dy00000001:f"]);
    const html = result.variants["dy00000001:0"]?.html ?? "";
    expect(html).toContain("Hello {{first_name|friend}}");
    expect(html).toContain("<strong>winter</strong>");
    expect(html).toContain("<em>here</em>");
    expect(html).toContain("<li>Yoga</li>");
    expect(html).toContain(`src="https://beam.be/api/public/files/${FILE}"`);
    expect(html).toContain('alt="The relaxation room"');
    expect(html).toContain('href="https://beam.be/en/book"');
    expect(html).toContain('href="{{portal_url}}"');
    expect(html).toContain("Ten-session card");
    expect(html).toContain("€199.00");
    expect(html).toContain("https://beam.be/en/account/shop/CARD-10");
    expect(html).toContain("Breathwork evening");
    expect(html).toContain("Thanks for being a member.");
    expect(html).not.toContain("Become a member.");
    expect(result.variants["dy00000001:f"]?.html).toContain("Become a member.");
    expect(result.warnings.filter((w) => w.code === "product_unavailable" || w.code === "event_unavailable")).toEqual([]);
  });

  it("columns stack on mobile unless stackOnMobile is false", async () => {
    const columns = (stackOnMobile: boolean): Block => ({
      id: "co00000002",
      type: "columns",
      stackOnMobile,
      columns: [
        { width: 30, blocks: [{ id: "tx00000006", type: "text", markdown: "A" }] },
        { width: 40, blocks: [] },
        { width: 30, blocks: [{ id: "tx00000007", type: "text", markdown: "C" }] },
      ],
    });
    const stacked = blocksToMjml([columns(true)], { locale: "en" });
    expect(stacked).not.toContain("<mj-group>");
    expect(stacked).toContain('<mj-column width="40%">');
    const html = (await compileMarketing(doc([columns(true)]), "en", { footer })).variants.default?.html ?? "";
    expect(html).toMatch(/mj-column-per-30/);
    expect(html).toMatch(/@media only screen and \(min-width:480px\)/);

    const fixed = blocksToMjml([columns(false)], { locale: "en" });
    expect(fixed).toContain("<mj-group>");
    await expect(compileMarketing(doc([columns(false)]), "en", { footer })).resolves.toBeTruthy();
  });

  it("an inactive or unknown card renders nothing and warns", async () => {
    const cards: ResolvedCards = { products: { [PRODUCT]: { ...CARDS.products[PRODUCT]!, active: false } }, events: {} };
    const result = await compileMarketing(doc(ALL_BLOCKS.slice(7, 9)), "en", { footer, resolveCards: () => cards });
    const html = result.variants.default?.html ?? "";
    expect(html).not.toContain("Ten-session card");
    expect(html).not.toContain("Reserve a seat");
    expect(result.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["product_unavailable", "event_unavailable"]));
  });

  it("collects card references across columns and variants", () => {
    expect(cardRefs([ALL_BLOCKS])).toEqual({ productIds: [PRODUCT], sessionIds: [SESSION] });
  });

  it("escapes text but keeps tokens for personalisation", () => {
    const out = blocksToMjml([{ id: "hd00000002", type: "heading", level: 2, text: "<script>x</script> & {{first_name|l'ami}}" }], { locale: "en" });
    expect(out).toContain("&lt;script&gt;x&lt;/script&gt; &amp; {{first_name|l'ami}}");
  });

  it("refuses invalid MJML with a CompileError", async () => {
    await expect(mjmlToHtml("<mjml><mj-body><mj-text>x</mj-text></mj-body></mjml>")).rejects.toBeInstanceOf(CompileError);
  });

  it("snapshot of a sample newsletter", () => {
    const newsletter: Block[] = [
      { id: "hd00000010", type: "heading", level: 1, text: "BEAM winter newsletter" },
      { id: "tx00000010", type: "text", markdown: "Dear {{first_name|member}},\n\nThe **new season** starts on 1 December." },
      { id: "bt00000010", type: "button", label: "Discover the programme", href: "https://beam.be/en/programme", style: "primary" },
      { id: "dv00000010", type: "divider" },
      {
        id: "co00000010",
        type: "columns",
        stackOnMobile: true,
        columns: [
          { width: 50, blocks: [{ id: "hd00000011", type: "heading", level: 2, text: "Yoga" }] },
          { width: 50, blocks: [{ id: "hd00000012", type: "heading", level: 2, text: "Sauna" }] },
        ],
      },
    ];
    expect(blocksToMjml(newsletter, { locale: "en" })).toMatchInlineSnapshot(`
      "<mj-section background-color="#ffffff" padding="0"><mj-column>
      <mj-text padding="8px 24px"><h1 style="margin:0;color:#1c1c1c;font-size:26px;line-height:1.3;font-weight:700">BEAM winter newsletter</h1></mj-text>
      <mj-text padding="8px 24px"><p style="margin:0 0 16px">Dear {{first_name|member}},</p>
      <p style="margin:0 0 16px">The <strong>new season</strong> starts on 1 December.</p></mj-text>
      <mj-button href="https://beam.be/en/programme" background-color="#1f3a2e" color="#ffffff" font-size="16px" font-weight="600" border-radius="6px" inner-padding="12px 24px" padding="12px 24px">Discover the programme</mj-button>
      <mj-divider border-color="#e5e1d8" border-width="1px" padding="16px 24px" />
      </mj-column></mj-section>
      <mj-section background-color="#ffffff" padding="0">
      <mj-column width="50%">
      <mj-text padding="8px 24px"><h2 style="margin:0;color:#1c1c1c;font-size:21px;line-height:1.3;font-weight:700">Yoga</h2></mj-text>
      </mj-column>
      <mj-column width="50%">
      <mj-text padding="8px 24px"><h2 style="margin:0;color:#1c1c1c;font-size:21px;line-height:1.3;font-weight:700">Sauna</h2></mj-text>
      </mj-column>
      </mj-section>"
    `);
  });
});
