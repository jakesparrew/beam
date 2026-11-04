import { describe, expect, it } from "vitest";
import type { Block } from "@beam/core/email";
import { blocksToText } from "./to-text";

const PRODUCT = "11111111-1111-4111-8111-111111111111";

describe("blocksToText", () => {
  it("underlines headings by level", () => {
    const text = blocksToText(
      [
        { id: "hd00000001", type: "heading", level: 1, text: "Winter news" },
        { id: "hd00000002", type: "heading", level: 2, text: "Yoga" },
      ],
      { locale: "en" },
    );
    expect(text).toBe("Winter news\n===========\n\nYoga\n----");
  });

  it("writes links and buttons as `text (url)`", () => {
    const text = blocksToText(
      [
        { id: "tx00000001", type: "text", markdown: "See **the** [full programme](https://beam.be/en/programme) or [your portal]({{portal_url}})." },
        { id: "bt00000001", type: "button", label: "Book now", href: "https://beam.be/en/book", style: "primary" },
        { id: "im00000001", type: "image", fileId: "33333333-3333-4333-8333-333333333333", alt: "Sauna", href: "https://beam.be/en/sauna" },
        { id: "im00000002", type: "image", fileId: "33333333-3333-4333-8333-333333333333", alt: "" },
      ],
      { locale: "en" },
    );
    expect(text).toContain("See the full programme (https://beam.be/en/programme) or your portal ({{portal_url}}).");
    expect(text).toContain("Book now (https://beam.be/en/book)");
    expect(text).toContain("Sauna (https://beam.be/en/sauna)");
    expect(text).not.toContain("<");
  });

  it("keeps bullet and numbered lists", () => {
    const text = blocksToText([{ id: "tx00000002", type: "text", markdown: "Bring:\n\n- a towel\n- water\n\n1. Arrive\n2. Relax" }], { locale: "en" });
    expect(text).toBe("Bring:\n\n- a towel\n- water\n\n1. Arrive\n2. Relax");
  });

  it("renders the chosen dynamic variant only, and the fallback otherwise", () => {
    const blocks: Block[] = [
      {
        id: "dy00000001",
        type: "dynamic",
        variants: [
          { when: { status: "lead" }, blocks: [{ id: "tx00000003", type: "text", markdown: "Lead content" }] },
          { when: { status: "member" }, blocks: [{ id: "tx00000004", type: "text", markdown: "Member content" }] },
        ],
        fallback: [{ id: "tx00000005", type: "text", markdown: "Fallback content" }],
      },
    ];
    expect(blocksToText(blocks, { locale: "en", choice: { dy00000001: 1 } })).toBe("Member content");
    expect(blocksToText(blocks, { locale: "en", choice: { dy00000001: 0 } })).toBe("Lead content");
    expect(blocksToText(blocks, { locale: "en" })).toBe("Fallback content");
  });

  it("renders columns in reading order and product cards with price and link", () => {
    const text = blocksToText(
      [
        {
          id: "co00000001",
          type: "columns",
          stackOnMobile: true,
          columns: [
            { width: 50, blocks: [{ id: "tx00000006", type: "text", markdown: "Left" }] },
            { width: 50, blocks: [{ id: "pr00000001", type: "product", productId: PRODUCT, showPrice: true, ctaLabel: "Koop de kaart" }] },
          ],
        },
        { id: "dv00000001", type: "divider" },
      ],
      { locale: "nl-BE", cards: { products: { [PRODUCT]: { id: PRODUCT, name: "Beurtenkaart", sku: "CARD-10", priceCents: 19900, active: true } }, events: {} } },
    );
    expect(text.indexOf("Left")).toBeLessThan(text.indexOf("Beurtenkaart"));
    expect(text).toContain("199,00");
    expect(text).toContain("Koop de kaart (https://beam.be/nl/account/shop/CARD-10)");
    expect(text).toMatch(/-{10,}$/);
  });
});
