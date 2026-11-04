import { describe, expect, it } from "vitest";
import {
  normalisePromoCode,
  personPriceAt,
  priceVersionAt,
  promotionAppliesTo,
  promotionUnitCents,
  quote,
} from "./pricing";
import type { PersonPriceRow, PriceVersionRow, PromotionRow, QuoteInput, QuoteProduct } from "./schemas";
import type { ProductKind } from "./types";

const AT = new Date("2026-11-03T10:00:00Z");
const EARLY = new Date("2026-01-01T00:00:00Z");
let seq = 0;
const uid = (p: string) => `${p}-${String(++seq).padStart(4, "0")}`;

function product(kind: ProductKind = "session", over: Partial<QuoteProduct> = {}): QuoteProduct {
  return {
    id: uid("prod"),
    kind,
    sku: `SKU-${seq}`,
    name: { en: "Day session", "nl-BE": "Dagsessie", "fr-BE": "Séance de jour" },
    vatRatePct: 21,
    memberDiscountPct: null,
    isActive: true,
    isCustomAmount: false,
    minAmountCents: null,
    maxAmountCents: null,
    ...over,
  };
}

function price(p: QuoteProduct, audience: PriceVersionRow["audience"], amountCents: number, over: Partial<PriceVersionRow> = {}): PriceVersionRow {
  return { id: uid(`pv-${audience}`), productId: p.id, version: 1, audience, amountCents, validFromAt: EARLY, validToAt: null, ...over };
}

function promo(over: Partial<PromotionRow & { isEligible: boolean }> = {}): PromotionRow & { isEligible: boolean } {
  return {
    id: uid("promo"),
    code: null,
    name: { en: "Promo" },
    kind: "percent",
    value: 10,
    appliesTo: { productIds: [], productKinds: [] },
    startsAt: EARLY,
    endsAt: null,
    maxUses: null,
    usesCount: 0,
    isActive: true,
    isEligible: true,
    ...over,
  };
}

function input(
  items: Array<{ product: QuoteProduct; prices: PriceVersionRow[]; quantity?: number; amountCents?: number }>,
  over: Partial<QuoteInput> = {},
): QuoteInput {
  return {
    items: items.map((i) => ({ productId: i.product.id, quantity: i.quantity ?? 1, amountCents: i.amountCents, product: i.product, prices: i.prices })),
    audience: "public",
    personStatus: "customer",
    isMember: false,
    memberDiscountPct: null,
    personPrices: [],
    promotions: [],
    promoCode: null,
    at: AT,
    ...over,
  };
}

describe("base price by audience (rules 5 and 7)", () => {
  it("uses the public version for a public order and the b2b version for a company order", () => {
    const p = product();
    const prices = [price(p, "public", 4_500), price(p, "b2b", 3_800)];
    expect(quote(input([{ product: p, prices }])).lines[0]!.unitAmountCents).toBe(4_500);
    const b2b = quote(input([{ product: p, prices }], { audience: "b2b" }));
    expect(b2b.lines[0]!.unitAmountCents).toBe(3_800);
    expect(b2b.lines[0]!.trace.audience).toBe("b2b");
  });

  it("falls back to the public version when no b2b version is valid", () => {
    const p = product();
    const pub = price(p, "public", 4_500);
    const line = quote(input([{ product: p, prices: [pub] }], { audience: "b2b" })).lines[0]!;
    expect(line.unitAmountCents).toBe(4_500);
    expect(line.priceVersionId).toBe(pub.id);
  });

  it("treats audience member as public for the base", () => {
    const p = product();
    const line = quote(input([{ product: p, prices: [price(p, "public", 4_500), price(p, "member", 4_000)] }], { audience: "member" })).lines[0]!;
    expect(line.unitAmountCents).toBe(4_500);
    expect(line.lineTotalCents).toBe(4_500);
  });

  it("multiplies by quantity and computes line VAT", () => {
    const p = product("package", { vatRatePct: 21 });
    const q = quote(input([{ product: p, prices: [price(p, "public", 20_000)], quantity: 2 }]));
    expect(q.lines[0]!.lineTotalCents).toBe(40_000);
    expect(q.lines[0]!.vatCents).toBe(6_942); // 40000 * 21 / 121 = 6942.15
    expect(q.subtotalCents).toBe(40_000);
    expect(q.totalCents).toBe(40_000);
    expect(q.vatCents).toBe(6_942);
  });
});

describe("member pricing (rule 8)", () => {
  it("a member price version beats a smaller member discount percentage", () => {
    const p = product("session", { memberDiscountPct: 5 });
    const member = price(p, "member", 3_900);
    const line = quote(input([{ product: p, prices: [price(p, "public", 4_500), member] }], { isMember: true })).lines[0]!;
    expect(line.trace.winner).toBe("member_version");
    expect(line.trace.winnerSourceId).toBe(member.id);
    expect(line.unitAmountCents).toBe(4_500);
    expect(line.discountCents).toBe(600);
    expect(line.lineTotalCents).toBe(3_900);
  });

  it("uses the membership's discount when the product has none", () => {
    const p = product();
    const line = quote(input([{ product: p, prices: [price(p, "public", 4_500)] }], { isMember: true, memberDiscountPct: 10 })).lines[0]!;
    expect(line.trace.winner).toBe("member_discount");
    expect(line.lineTotalCents).toBe(4_050);
  });

  it("gives no member pricing to non-members and no member discount on b2b orders", () => {
    const p = product("session", { memberDiscountPct: 20 });
    const prices = [price(p, "public", 4_500), price(p, "b2b", 4_200)];
    expect(quote(input([{ product: p, prices }])).lines[0]!.trace.winner).toBe("base");
    const b2b = quote(input([{ product: p, prices }], { audience: "b2b", isMember: true })).lines[0]!;
    expect(b2b.trace.winner).toBe("base");
    expect(b2b.trace.candidates.map((c) => c.source)).not.toContain("member_discount");
  });
});

describe("person prices (rule 6)", () => {
  it("a valid person price wins over the member price", () => {
    const p = product("session", { memberDiscountPct: 10 });
    const pp: PersonPriceRow = { id: uid("pp"), productId: p.id, amountCents: 3_000, validFromAt: EARLY, validToAt: null, revokedAt: null };
    const line = quote(
      input([{ product: p, prices: [price(p, "public", 4_500), price(p, "member", 3_800)] }], { isMember: true, personPrices: [pp] }),
    ).lines[0]!;
    expect(line.trace.winner).toBe("person_price");
    expect(line.lineTotalCents).toBe(3_000);
  });

  it("ignores revoked, expired and other products' person prices; the latest valid_from_at wins", () => {
    const p = product();
    const rows: PersonPriceRow[] = [
      { id: "revoked", productId: p.id, amountCents: 100, validFromAt: EARLY, validToAt: null, revokedAt: EARLY },
      { id: "ended", productId: p.id, amountCents: 200, validFromAt: EARLY, validToAt: new Date("2026-06-01T00:00:00Z"), revokedAt: null },
      { id: "other", productId: "other-product", amountCents: 300, validFromAt: EARLY, validToAt: null, revokedAt: null },
      { id: "older", productId: p.id, amountCents: 3_000, validFromAt: EARLY, validToAt: null, revokedAt: null },
      { id: "newer", productId: p.id, amountCents: 3_500, validFromAt: new Date("2026-05-01T00:00:00Z"), validToAt: null, revokedAt: null },
    ];
    expect(personPriceAt(rows, p.id, AT)?.id).toBe("newer");
  });
});

describe("promotions (rules 8e, 9, 10, 12, 13)", () => {
  it("takes the best single discount and never stacks", () => {
    const p = product("session", { memberDiscountPct: 10 });
    const auto = promo({ value: 20 });
    const q = quote(input([{ product: p, prices: [price(p, "public", 5_000)] }], { isMember: true, promotions: [auto] }));
    const line = q.lines[0]!;
    expect(line.trace.winner).toBe("promotion");
    expect(line.promotionId).toBe(auto.id);
    expect(line.discountCents).toBe(1_000); // 20 %, not 20 % + 10 %
    expect(line.lineTotalCents).toBe(4_000);
    expect(q.promotionId).toBeNull(); // automatic: not the order's code promotion
  });

  it("breaks ties in the order person price, member version, member discount, automatic, code (rule 9)", () => {
    const p = product("session", { memberDiscountPct: 10 });
    const prices = [price(p, "public", 5_000), price(p, "member", 4_500)];
    const pp: PersonPriceRow = { id: uid("pp"), productId: p.id, amountCents: 4_500, validFromAt: EARLY, validToAt: null, revokedAt: null };
    const auto = promo({ value: 10 });
    const coded = promo({ code: "SPRING10", value: 10 });
    const all = { isMember: true, personPrices: [pp], promotions: [auto, coded], promoCode: "spring10" };
    expect(quote(input([{ product: p, prices }], all)).lines[0]!.trace.winner).toBe("person_price");
    expect(quote(input([{ product: p, prices }], { ...all, personPrices: [] })).lines[0]!.trace.winner).toBe("member_version");
    expect(quote(input([{ product: p, prices: [prices[0]!] }], { ...all, personPrices: [] })).lines[0]!.trace.winner).toBe("member_discount");
    const noMember = quote(input([{ product: p, prices: [prices[0]!] }], { ...all, personPrices: [], isMember: false }));
    expect(noMember.lines[0]!.trace.winner).toBe("promotion");
    expect(noMember.lines[0]!.promotionId).toBe(auto.id);
    expect(noMember.warnings).toContainEqual({ code: "promo_not_better" });
    const codeOnly = quote(input([{ product: p, prices: [prices[0]!] }], { ...all, personPrices: [], isMember: false, promotions: [coded] }));
    expect(codeOnly.lines[0]!.promotionId).toBe(coded.id);
    expect(codeOnly.promotionId).toBe(coded.id);
    expect(codeOnly.warnings).toEqual([]);
  });

  it("does not consume a promotion that gives nothing extra over the base", () => {
    const p = product();
    const zero = promo({ code: "ZERO", kind: "fixed", value: 0 });
    const q = quote(input([{ product: p, prices: [price(p, "public", 4_500)] }], { promotions: [zero], promoCode: "ZERO" }));
    expect(q.lines[0]!.trace.winner).toBe("base");
    expect(q.promotionId).toBeNull();
    expect(q.warnings).toContainEqual({ code: "promo_not_better" });
  });

  it("caps a fixed promotion at the unit price and applies it per unit", () => {
    expect(promotionUnitCents({ kind: "fixed", value: 10_000 }, 4_500)).toBe(0);
    const p = product();
    const fixed = promo({ kind: "fixed", value: 500 });
    const line = quote(input([{ product: p, prices: [price(p, "public", 4_500)], quantity: 1 }], { promotions: [fixed] })).lines[0]!;
    expect(line.lineTotalCents).toBe(4_000);
    const big = promo({ kind: "fixed", value: 99_999 });
    const free = quote(input([{ product: p, prices: [price(p, "public", 4_500)] }], { promotions: [big] }));
    expect(free.totalCents).toBe(0);
    expect(free.lines[0]!.discountCents).toBe(4_500);
  });

  it("rounds a percent discount per unit half up and multiplies by quantity", () => {
    const p = product("package");
    const pct = promo({ value: 15, appliesTo: { productIds: [], productKinds: ["package"] } });
    const line = quote(input([{ product: p, prices: [price(p, "public", 3_333)], quantity: 3 }], { promotions: [pct] })).lines[0]!;
    // 3333 * 15 % = 499.95 -> 500 per unit
    expect(line.discountCents).toBe(1_500);
    expect(line.lineTotalCents).toBe(3 * 3_333 - 1_500);
  });

  it("excludes vouchers and memberships from member pricing and from general promotions", () => {
    const voucher = product("voucher", { vatRatePct: 0, memberDiscountPct: 10 });
    const membership = product("membership", { memberDiscountPct: 10 });
    const general = promo({ value: 50 });
    const q = quote(
      input(
        [
          { product: voucher, prices: [price(voucher, "public", 5_000), price(voucher, "member", 1_000)] },
          { product: membership, prices: [price(membership, "public", 8_900)] },
        ],
        { isMember: true, memberDiscountPct: 20, promotions: [general] },
      ),
    );
    expect(q.lines.map((l) => l.trace.winner)).toEqual(["base", "base"]);
    expect(q.totalCents).toBe(13_900);
    expect(promotionAppliesTo({ appliesTo: { productIds: [], productKinds: ["membership"] } }, membership)).toBe(false);
    const explicit = promo({ value: 50, appliesTo: { productIds: [membership.id], productKinds: [] } });
    const q2 = quote(input([{ product: membership, prices: [price(membership, "public", 8_900)] }], { promotions: [explicit] }));
    expect(q2.lines[0]!.lineTotalCents).toBe(4_450);
  });

  it("respects applies_to product kinds", () => {
    const session = product("session");
    const item = product("item");
    const onlyItems = promo({ value: 10, appliesTo: { productIds: [], productKinds: ["item"] } });
    const q = quote(
      input(
        [
          { product: session, prices: [price(session, "public", 4_500)] },
          { product: item, prices: [price(item, "public", 2_000)] },
        ],
        { promotions: [onlyItems] },
      ),
    );
    expect(q.lines[0]!.discountCents).toBe(0);
    expect(q.lines[1]!.discountCents).toBe(200);
  });
});

describe("promotion warnings (rule 13)", () => {
  const p = product();
  const prices = [price(p, "public", 4_500)];
  const run = (promotions: Array<PromotionRow & { isEligible: boolean }>, code: string) =>
    quote(input([{ product: p, prices }], { promotions, promoCode: code }));

  it.each([
    ["promo_unknown", [], "NOPE"],
    ["promo_inactive", [promo({ code: "OFF1", isActive: false })], "OFF1"],
    ["promo_expired", [promo({ code: "LATE", endsAt: new Date("2026-10-01T00:00:00Z") })], "LATE"],
    ["promo_expired", [promo({ code: "SOON", startsAt: new Date("2026-12-01T00:00:00Z") })], "SOON"],
    ["promo_exhausted", [promo({ code: "GONE", maxUses: 5, usesCount: 5 })], "GONE"],
    ["promo_not_eligible", [promo({ code: "VIPS", isEligible: false })], "VIPS"],
    ["promo_not_eligible", [promo({ code: "ITEM", appliesTo: { productIds: [], productKinds: ["item"] } })], "ITEM"],
  ] as const)("%s", (warning, promotions, code) => {
    const q = run([...promotions], code);
    expect(q.warnings).toEqual([{ code: warning }]);
    expect(q.totalCents).toBe(4_500); // the order still proceeds without it
    expect(q.promotionId).toBeNull();
  });

  it("promo_not_better when a better price already wins", () => {
    const q = quote(
      input([{ product: p, prices: [...prices, price(p, "member", 3_000)] }], {
        isMember: true,
        promotions: [promo({ code: "TEN1", value: 10 })],
        promoCode: "TEN1",
      }),
    );
    expect(q.warnings).toEqual([{ code: "promo_not_better" }]);
  });

  it("ignores unusable automatic promotions silently", () => {
    const q = run([promo({ isActive: false, value: 50 }), promo({ isEligible: false, value: 50 })], "");
    expect(q.warnings).toEqual([]);
    expect(q.totalCents).toBe(4_500);
  });

  it("matches codes case-insensitively", () => {
    expect(normalisePromoCode("  spring10 ")).toBe("SPRING10");
    expect(normalisePromoCode("")).toBeNull();
  });
});

describe("product warnings", () => {
  it("drops an inactive product and a product without price", () => {
    const off = product("item", { isActive: false });
    const noPrice = product("item");
    const ok = product("item");
    const q = quote(
      input([
        { product: off, prices: [price(off, "public", 100)] },
        { product: noPrice, prices: [price(noPrice, "member", 100)] },
        { product: ok, prices: [price(ok, "public", 1_000)] },
      ]),
    );
    expect(q.lines.map((l) => l.productId)).toEqual([ok.id]);
    expect(q.warnings).toEqual([
      { code: "product_unavailable", productId: off.id },
      { code: "no_price", productId: noPrice.id },
    ]);
  });

  it("prices a custom-amount voucher from the item and checks its range", () => {
    const v = product("voucher", { vatRatePct: 0, isCustomAmount: true, minAmountCents: 2_500, maxAmountCents: 50_000 });
    const q = quote(input([{ product: v, prices: [], amountCents: 7_500 }]));
    expect(q.lines[0]).toMatchObject({ priceVersionId: null, unitAmountCents: 7_500, vatCents: 0, lineTotalCents: 7_500 });
    const tooLow = quote(input([{ product: v, prices: [], amountCents: 1_000 }]));
    expect(tooLow.lines).toEqual([]);
    expect(tooLow.warnings).toEqual([{ code: "amount_out_of_range", productId: v.id }]);
  });
});

describe("pricing trace (rule 14)", () => {
  it("records at, audience, base, every candidate, the winner, rounding and the status used", () => {
    const p = product("session", { memberDiscountPct: 10 });
    const pub = price(p, "public", 4_500);
    const auto = promo({ value: 5 });
    const line = quote(input([{ product: p, prices: [pub] }], { isMember: true, personStatus: "member", promotions: [auto] })).lines[0]!;
    expect(line.trace).toEqual({
      at: AT.toISOString(),
      audience: "public",
      personStatus: "member",
      baseVersionId: pub.id,
      baseUnitCents: 4_500,
      candidates: [
        { source: "base", sourceId: pub.id, unitCents: 4_500, reason: "public_price" },
        { source: "member_discount", sourceId: null, unitCents: 4_050, reason: "member_discount_10pct" },
        { source: "promotion", sourceId: auto.id, unitCents: 4_275, reason: "automatic_percent_5" },
      ],
      winner: "member_discount",
      winnerSourceId: null,
      isMember: true,
      quantity: 1,
      vatRatePct: 21,
      rounding: "half_up",
    });
  });
});

describe("price history and time-limited prices (rules 4 and 5)", () => {
  it("a historical `at` picks the older version", () => {
    const p = product();
    const v1 = price(p, "public", 4_000, { version: 1, validFromAt: EARLY });
    const v2 = price(p, "public", 4_500, { version: 2, validFromAt: new Date("2026-09-01T00:00:00Z") });
    expect(quote(input([{ product: p, prices: [v1, v2] }])).lines[0]!.priceVersionId).toBe(v2.id);
    const past = quote(input([{ product: p, prices: [v1, v2] }], { at: new Date("2026-06-01T00:00:00Z") }));
    expect(past.lines[0]!.priceVersionId).toBe(v1.id);
    expect(past.lines[0]!.unitAmountCents).toBe(4_000);
  });

  it("a time-limited higher version falls back to the open version after valid_to_at", () => {
    const p = product();
    const open = price(p, "public", 4_500, { version: 1 });
    const spring = price(p, "public", 3_900, {
      version: 2,
      validFromAt: new Date("2026-11-01T00:00:00Z"),
      validToAt: new Date("2026-11-10T00:00:00Z"),
    });
    expect(priceVersionAt([open, spring], "public", AT)?.id).toBe(spring.id);
    expect(priceVersionAt([open, spring], "public", new Date("2026-11-10T00:00:00Z"))?.id).toBe(open.id);
    const after = quote(input([{ product: p, prices: [open, spring] }], { at: new Date("2026-11-20T00:00:00Z") }));
    expect(after.lines[0]!.unitAmountCents).toBe(4_500);
  });

  it("returns null before any version is valid", () => {
    const p = product();
    expect(priceVersionAt([price(p, "public", 1, { validFromAt: AT })], "public", EARLY)).toBeNull();
  });
});
