/**
 * The pure `quote()` (commerce rules 5 to 14). Everything it needs is loaded by `getQuote()`
 * and passed in: products with their price versions, person prices, promotions with their
 * eligibility already decided (rule 17), membership state and the moment `at`.
 *
 * Per line the candidates are the base price, the member price version, a person price, the
 * member discount and every applicable promotion. The lowest unit price wins; discounts never
 * stack. Ties go to the earlier entry of `TIE_ORDER`, so a promotion that gives nothing extra is
 * never consumed (rule 9).
 *
 * R2 (commerce-P8): a cart with several ticket types of one event. Each ticket type sells through
 * its own product (`ticket_types.product_id`), so a member price, member discount or promotion is
 * decided per type by the same candidates; `groupTicketTypes` sums the quoted seat lines per
 * ticket type for the basket, the confirmation and the recovery email, and `ticketCartSession`
 * refuses a cart that mixes events.
 */
import type { Audience, ProductKind } from "./types";
import type {
  CartItem,
  PricingCandidateSource,
  PersonPriceRow,
  PriceVersionRow,
  PricingCandidate,
  PricingTrace,
  PromotionRow,
  Quote,
  QuoteInput,
  QuoteLine,
  QuoteProduct,
  QuoteWarning,
} from "./schemas";
import { percentOf, vatOf } from "./vat";

/** Kinds that member pricing never reaches and promotions only through `applies_to.product_ids` (rule 12). */
export const MEMBER_PRICING_EXCLUDED_KINDS: readonly ProductKind[] = ["voucher", "membership"];

type CandidateKey = "base" | "person_price" | "member_version" | "member_discount" | "promotion_auto" | "promotion_code";

/** Tie order (rule 9); the base comes first so an equal candidate never consumes anything. */
export const TIE_ORDER: readonly CandidateKey[] = [
  "base",
  "person_price",
  "member_version",
  "member_discount",
  "promotion_auto",
  "promotion_code",
];

const inWindow = (at: Date, from: Date, to: Date | null) => from.getTime() <= at.getTime() && (to === null || to.getTime() > at.getTime());

/** The price of (product, audience, at): the highest version whose window contains `at` (rule 5). */
export function priceVersionAt(prices: readonly PriceVersionRow[], audience: Audience, at: Date): PriceVersionRow | null {
  let best: PriceVersionRow | null = null;
  for (const p of prices) {
    if (p.audience !== audience || !inWindow(at, p.validFromAt, p.validToAt)) continue;
    if (best === null || p.version > best.version) best = p;
  }
  return best;
}

/** A valid, unrevoked person price for the product; the latest `valid_from_at` wins (rule 6). */
export function personPriceAt(rows: readonly PersonPriceRow[], productId: string, at: Date): PersonPriceRow | null {
  let best: PersonPriceRow | null = null;
  for (const r of rows) {
    if (r.productId !== productId || r.revokedAt !== null || !inWindow(at, r.validFromAt, r.validToAt)) continue;
    if (best === null || r.validFromAt.getTime() > best.validFromAt.getTime()) best = r;
  }
  return best;
}

/** Whether a promotion reaches a product (`applies_to`, rule 12). */
export function promotionAppliesTo(promotion: Pick<PromotionRow, "appliesTo">, product: Pick<QuoteProduct, "id" | "kind">): boolean {
  const { productIds, productKinds } = promotion.appliesTo;
  if (productIds.includes(product.id)) return true;
  if (MEMBER_PRICING_EXCLUDED_KINDS.includes(product.kind)) return false;
  if (productIds.length === 0 && productKinds.length === 0) return true;
  return productKinds.includes(product.kind);
}

/** Why a promotion cannot be used at `at`, or null when it is usable (rules 13 and 17). */
export function promotionProblem(
  promotion: PromotionRow & { isEligible: boolean },
  at: Date,
): "promo_inactive" | "promo_expired" | "promo_exhausted" | "promo_not_eligible" | null {
  if (!promotion.isActive) return "promo_inactive";
  if (!inWindow(at, promotion.startsAt, promotion.endsAt)) return "promo_expired";
  if (promotion.maxUses !== null && promotion.usesCount >= promotion.maxUses) return "promo_exhausted";
  if (!promotion.isEligible) return "promo_not_eligible";
  return null;
}

/** Unit price after a promotion (rule 10): percent rounded half up, fixed capped at the unit price. */
export function promotionUnitCents(promotion: Pick<PromotionRow, "kind" | "value">, baseUnitCents: number): number {
  const off = promotion.kind === "percent" ? percentOf(baseUnitCents, promotion.value) : Math.min(promotion.value, baseUnitCents);
  return Math.max(0, baseUnitCents - Math.max(0, off));
}

/** Normalises a typed promotion code (codes are stored upper case, rule on `promotions.code`). */
export function normalisePromoCode(code: string | null | undefined): string | null {
  const c = (code ?? "").trim().toUpperCase();
  return c === "" ? null : c;
}

type Ranked = PricingCandidate & { key: CandidateKey };

function pickWinner(candidates: Ranked[]): Ranked {
  let best = candidates[0]!;
  for (const c of candidates.slice(1)) {
    if (c.unitCents < best.unitCents) best = c;
    else if (c.unitCents === best.unitCents && TIE_ORDER.indexOf(c.key) < TIE_ORDER.indexOf(best.key)) best = c;
  }
  return best;
}

/** The pure pricing function. */
export function quote(input: QuoteInput): Quote {
  return quoteDetailed(input).quote;
}

/** `quote()` plus, per quoted line, the index of the input item it prices (lines skip refused items). */
function quoteDetailed(input: QuoteInput): { quote: Quote; itemIndex: number[] } {
  const itemIndex: number[] = [];
  const warnings: QuoteWarning[] = [];
  const at = input.at;
  const baseAudience: Audience = input.audience === "b2b" ? "b2b" : "public";
  const code = normalisePromoCode(input.promoCode);

  const codePromotion = code === null ? undefined : input.promotions.find((p) => p.code !== null && p.code.toUpperCase() === code);
  let codeUsable = false;
  if (code !== null) {
    if (codePromotion === undefined) warnings.push({ code: "promo_unknown" });
    else {
      const problem = promotionProblem(codePromotion, at);
      if (problem) warnings.push({ code: problem });
      else codeUsable = true;
    }
  }
  const automatic = input.promotions.filter((p) => p.code === null && promotionProblem(p, at) === null);

  const lines: QuoteLine[] = [];
  let codeApplied = false;
  let codeWon = false;

  for (const [index, item] of input.items.entries()) {
    const { product } = item;
    if (!product.isActive) {
      warnings.push({ code: "product_unavailable", productId: product.id });
      continue;
    }

    // Base unit price (rules 5 and 7).
    let baseVersion: PriceVersionRow | null = null;
    let baseUnitCents: number;
    if (product.isCustomAmount) {
      const amount = item.amountCents;
      if (
        amount === undefined ||
        (product.minAmountCents !== null && amount < product.minAmountCents) ||
        (product.maxAmountCents !== null && amount > product.maxAmountCents)
      ) {
        warnings.push({ code: "amount_out_of_range", productId: product.id });
        continue;
      }
      baseUnitCents = amount;
    } else {
      baseVersion = priceVersionAt(item.prices, baseAudience, at) ?? (baseAudience === "b2b" ? priceVersionAt(item.prices, "public", at) : null);
      if (baseVersion === null) {
        warnings.push({ code: "no_price", productId: product.id });
        continue;
      }
      baseUnitCents = baseVersion.amountCents;
    }

    const excluded = MEMBER_PRICING_EXCLUDED_KINDS.includes(product.kind);
    const candidates: Ranked[] = [
      { key: "base", source: "base", sourceId: baseVersion?.id ?? null, unitCents: baseUnitCents, reason: `${baseAudience}_price` },
    ];

    const personPrice = personPriceAt(input.personPrices, product.id, at);
    if (personPrice) {
      candidates.push({ key: "person_price", source: "person_price", sourceId: personPrice.id, unitCents: personPrice.amountCents, reason: "person_price" });
    }

    if (input.isMember && !excluded && !product.isCustomAmount) {
      const memberVersion = priceVersionAt(item.prices, "member", at);
      if (memberVersion) {
        candidates.push({
          key: "member_version",
          source: "member_version",
          sourceId: memberVersion.id,
          unitCents: memberVersion.amountCents,
          reason: "member_price_version",
        });
      }
      const pct = product.memberDiscountPct ?? input.memberDiscountPct;
      if (baseAudience !== "b2b" && pct !== null && Number(pct) > 0) {
        candidates.push({
          key: "member_discount",
          source: "member_discount",
          sourceId: null,
          unitCents: Math.max(0, baseUnitCents - percentOf(baseUnitCents, pct)),
          reason: `member_discount_${Number(pct)}pct`,
        });
      }
    }

    for (const promo of automatic) {
      if (!promotionAppliesTo(promo, product)) continue;
      candidates.push({
        key: "promotion_auto",
        source: "promotion",
        sourceId: promo.id,
        unitCents: promotionUnitCents(promo, baseUnitCents),
        reason: `automatic_${promo.kind}_${promo.value}`,
      });
    }
    if (codeUsable && codePromotion && promotionAppliesTo(codePromotion, product)) {
      codeApplied = true;
      candidates.push({
        key: "promotion_code",
        source: "promotion",
        sourceId: codePromotion.id,
        unitCents: promotionUnitCents(codePromotion, baseUnitCents),
        reason: `code_${codePromotion.code}_${codePromotion.kind}_${codePromotion.value}`,
      });
    }

    const winner = pickWinner(candidates);
    if (winner.key === "promotion_code") codeWon = true;
    const discountCents = (baseUnitCents - winner.unitCents) * item.quantity;
    const lineTotalCents = baseUnitCents * item.quantity - discountCents;
    const vatRatePct = Number(product.vatRatePct);
    const trace: PricingTrace = {
      at: at.toISOString(),
      audience: baseAudience,
      personStatus: input.personStatus,
      baseVersionId: baseVersion?.id ?? null,
      baseUnitCents,
      candidates: candidates.map(({ source, sourceId, unitCents, reason }) => ({ source, sourceId, unitCents, reason })),
      winner: winner.source,
      winnerSourceId: winner.sourceId,
      isMember: input.isMember,
      quantity: item.quantity,
      vatRatePct,
      rounding: "half_up",
    };
    lines.push({
      productId: product.id,
      priceVersionId: baseVersion?.id ?? null,
      quantity: item.quantity,
      unitAmountCents: baseUnitCents,
      discountCents,
      lineTotalCents,
      vatRatePct,
      vatCents: vatOf(lineTotalCents, vatRatePct),
      promotionId: winner.source === "promotion" ? winner.sourceId : null,
      trace,
    });
    itemIndex.push(index);
  }

  if (codeUsable && !codeWon) warnings.push({ code: codeApplied ? "promo_not_better" : "promo_not_eligible" });

  const subtotalCents = lines.reduce((s, l) => s + l.unitAmountCents * l.quantity, 0);
  const discountCents = lines.reduce((s, l) => s + l.discountCents, 0);
  return {
    quote: {
      lines,
      subtotalCents,
      discountCents,
      vatCents: lines.reduce((s, l) => s + l.vatCents, 0),
      totalCents: subtotalCents - discountCents,
      promotionId: codeWon && codePromotion ? codePromotion.id : null,
      warnings,
    },
    itemIndex,
  };
}

// ---------------------------------------------------------------------------
// Multi-ticket carts (R2): several ticket types of one event
// ---------------------------------------------------------------------------

/** The quoted seats of one ticket type of the cart. */
export type TicketTypeGroup = {
  ticketTypeId: string;
  sessionId: string | null;
  productId: string;
  /** Seats of this type (each seat is its own quantity-1 line, rule 21). */
  quantity: number;
  /** The base unit price of the type (its product's public or b2b price). */
  unitAmountCents: number;
  /** What one seat costs after the winning candidate (the lowest seat when lines differ). */
  pricedUnitCents: number;
  subtotalCents: number;
  discountCents: number;
  lineTotalCents: number;
  vatCents: number;
  /** The winning candidate of the type's first line (`member_version`, `member_discount`, ...). */
  winner: PricingCandidateSource;
  /** Whether a member price or member discount won for this type. */
  isMemberPrice: boolean;
  /** Indexes of the quoted lines in `quote(input).lines`, in order. */
  lineIndexes: number[];
};

/**
 * Groups the quoted lines of ticket items (`ticketTypeId` set) per ticket type, in the order the
 * types first appear; items without a ticket type and refused items are left out. Returns the
 * full quote of the input with the groups, so callers price once.
 */
export function groupTicketTypes(input: QuoteInput): { quote: Quote; groups: TicketTypeGroup[] } {
  const { quote: q, itemIndex } = quoteDetailed(input);
  const groups = new Map<string, TicketTypeGroup>();
  q.lines.forEach((line, lineIndex) => {
    const item = input.items[itemIndex[lineIndex]!]!;
    if (!item.ticketTypeId) return;
    const perSeat = line.quantity > 0 ? Math.floor(line.lineTotalCents / line.quantity) : line.lineTotalCents;
    const g = groups.get(item.ticketTypeId);
    if (!g) {
      groups.set(item.ticketTypeId, {
        ticketTypeId: item.ticketTypeId,
        sessionId: item.sessionId ?? null,
        productId: line.productId,
        quantity: line.quantity,
        unitAmountCents: line.unitAmountCents,
        pricedUnitCents: perSeat,
        subtotalCents: line.unitAmountCents * line.quantity,
        discountCents: line.discountCents,
        lineTotalCents: line.lineTotalCents,
        vatCents: line.vatCents,
        winner: line.trace.winner,
        isMemberPrice: line.trace.winner === "member_version" || line.trace.winner === "member_discount",
        lineIndexes: [lineIndex],
      });
      return;
    }
    g.quantity += line.quantity;
    g.pricedUnitCents = Math.min(g.pricedUnitCents, perSeat);
    g.subtotalCents += line.unitAmountCents * line.quantity;
    g.discountCents += line.discountCents;
    g.lineTotalCents += line.lineTotalCents;
    g.vatCents += line.vatCents;
    g.lineIndexes.push(lineIndex);
  });
  return { quote: q, groups: [...groups.values()] };
}

/**
 * The one event (session) of a ticket cart: ticket items must all carry the same `sessionId`
 * (a cart sells several ticket types of one event). `mixed_events` when they differ,
 * `ticket_without_session` when a ticket item has no session; `sessionId` null without tickets.
 */
export function ticketCartSession(
  items: readonly Pick<CartItem, "sessionId" | "ticketTypeId">[],
): { sessionId: string | null; problem: "mixed_events" | "ticket_without_session" | null } {
  let sessionId: string | null = null;
  for (const item of items) {
    if (!item.ticketTypeId) continue;
    if (!item.sessionId) return { sessionId: null, problem: "ticket_without_session" };
    if (sessionId === null) sessionId = item.sessionId;
    else if (sessionId !== item.sessionId) return { sessionId: null, problem: "mixed_events" };
  }
  return { sessionId, problem: null };
}
