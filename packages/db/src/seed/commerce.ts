/**
 * commerce seeds (commerce-P3, commerce spec section 12 and runbook 6.3).
 *
 * - `seed` (the `defaults` profile, also run in production): the settings rows `commerce` and
 *   `payment_provider_by_channel` with the defaults of spec section 2.4 (the same values as
 *   `apps/web/modules/commerce/config.ts`, from `@beam/core/commerce`), `on conflict (key) do
 *   nothing`, so a value staff changed is never overwritten.
 * - `seedCommerceCatalogue` (the `demo` profile helper, called by `apps/web/modules/commerce/seed.ts`):
 *   the demo catalogue of the spec with price versions and the two demo promotions. The real
 *   catalogue is entered by BEAM staff, so production gets no products. Idempotent on natural
 *   keys: products by SKU, price versions by (product, audience, version), code promotions by
 *   code and the automatic promotion by its English name.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { COMMERCE_SETTINGS_DEFAULTS, PAYMENT_PROVIDER_BY_CHANNEL_DEFAULTS } from "@beam/core/commerce";
import type { DbOrTx } from "../client";
import { priceVersions, products, promotions } from "../schema/commerce";
import { settings } from "../schema/platform";
import type { LocalizedText } from "../schema/_shared";
import type { DefaultSeed } from "./run";

/** Inserts the two commerce settings rows; idempotent. */
export async function seedCommerceDefaults(db: DbOrTx): Promise<void> {
  await db
    .insert(settings)
    .values([
      { key: "commerce", value: COMMERCE_SETTINGS_DEFAULTS },
      { key: "payment_provider_by_channel", value: PAYMENT_PROVIDER_BY_CHANNEL_DEFAULTS },
    ])
    .onConflictDoNothing({ target: settings.key });
}

export const seed: DefaultSeed = {
  after: ["platform"],
  run: (db) => seedCommerceDefaults(db),
};

// ---------------------------------------------------------------------------
// Demo catalogue
// ---------------------------------------------------------------------------

type ProductInsert = typeof products.$inferInsert;
type DemoPrice = { amountCents: number; validFromAt?: Date; validToAt?: Date | null; reason?: string };
type DemoProduct = Omit<ProductInsert, "id" | "createdAt" | "updatedAt"> & { prices: DemoPrice[] };

const DAY = 24 * 60 * 60 * 1000;

/** 00:00 Europe/Brussels of a winter date (UTC+1), as an instant. */
const brusselsWinterMidnight = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d) - 60 * 60 * 1000);
/** 00:00 Europe/Brussels of a summer-time date (UTC+2), as an instant. */
const brusselsSummerMidnight = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d) - 2 * 60 * 60 * 1000);

const text = (nl: string, fr: string, en: string): LocalizedText => ({ "nl-BE": nl, "fr-BE": fr, en });

/** The SKUs of the demo catalogue (`DemoIds` key `commerce.product.<sku>`). */
export const DEMO_SKUS = {
  dayWalkIn: "DAY-WALKIN",
  night: "NIGHT-STAY",
  package5Days: "PKG-5-DAYS",
  package10Days: "PKG-10-DAYS",
  package2Nights: "PKG-2-NIGHTS",
  membershipMonthly: "MEMBER-MONTHLY",
  eventTicket: "TICKET-EVENT",
  giftVoucher: "GIFT-VOUCHER",
  waterBottle: "MERCH-BOTTLE",
} as const;

function demoProducts(now: Date): DemoProduct[] {
  const historyStart = new Date(now.getTime() - 120 * DAY);
  // The 10-day package cost €360 until 1 October and €380 since (two versions in the history).
  const year = now.getUTCMonth() >= 9 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const priceChange = brusselsSummerMidnight(year, 10, 1);
  const tenDayStart = new Date(Math.min(historyStart.getTime(), priceChange.getTime() - 30 * DAY));
  const from = historyStart;
  return [
    {
      kind: "session",
      sku: DEMO_SKUS.dayWalkIn,
      name: text("Dagsessie (losse beurt)", "Séance de jour (à l’unité)", "Day session (walk-in)"),
      description: text(
        "Twee uur rust en herstel in de BEAM-ruimtes, zonder pakket.",
        "Deux heures de repos et de récupération dans les espaces BEAM, sans forfait.",
        "Two hours of rest and recovery in the BEAM spaces, no package needed.",
      ),
      vatRatePct: "21.00",
      isShopVisible: false,
      sortOrder: 10,
      prices: [{ amountCents: 4_500, validFromAt: from }],
    },
    {
      kind: "night",
      sku: DEMO_SKUS.night,
      name: text("Nacht bij BEAM", "Nuit chez BEAM", "Night at BEAM"),
      description: text(
        "Een volledige nacht herstel, van 21:00 tot 09:00.",
        "Une nuit complète de récupération, de 21h00 à 9h00.",
        "A full night of recovery, from 21:00 to 09:00.",
      ),
      vatRatePct: "6.00",
      isShopVisible: false,
      sortOrder: 20,
      prices: [{ amountCents: 9_500, validFromAt: from }],
    },
    {
      kind: "package",
      sku: DEMO_SKUS.package5Days,
      name: text("Pakket 5 dagsessies", "Forfait 5 séances de jour", "5 day sessions package"),
      description: text(
        "Vijf dagsessies, zes maanden geldig. Je mag een gast meenemen.",
        "Cinq séances de jour, valables six mois. Vous pouvez venir avec un invité.",
        "Five day sessions, valid for six months. You may bring a guest.",
      ),
      vatRatePct: "21.00",
      creditKind: "day",
      creditUnits: 5,
      validityDays: 183,
      isSharingAllowed: true,
      isShopVisible: true,
      sortOrder: 30,
      prices: [{ amountCents: 20_000, validFromAt: from }],
    },
    {
      kind: "package",
      sku: DEMO_SKUS.package10Days,
      name: text("Pakket 10 dagsessies", "Forfait 10 séances de jour", "10 day sessions package"),
      description: text(
        "Tien dagsessies, twaalf maanden geldig. Je mag een gast meenemen.",
        "Dix séances de jour, valables douze mois. Vous pouvez venir avec un invité.",
        "Ten day sessions, valid for twelve months. You may bring a guest.",
      ),
      vatRatePct: "21.00",
      creditKind: "day",
      creditUnits: 10,
      validityDays: 365,
      isSharingAllowed: true,
      isShopVisible: true,
      sortOrder: 40,
      prices: [
        { amountCents: 36_000, validFromAt: tenDayStart, validToAt: priceChange, reason: "Introductory price" },
        { amountCents: 38_000, validFromAt: priceChange, reason: "Price from 1 October" },
      ],
    },
    {
      kind: "package",
      sku: DEMO_SKUS.package2Nights,
      name: text("Pakket 2 nachten", "Forfait 2 nuits", "2 nights package"),
      description: text(
        "Twee nachten bij BEAM, twaalf maanden geldig.",
        "Deux nuits chez BEAM, valables douze mois.",
        "Two nights at BEAM, valid for twelve months.",
      ),
      vatRatePct: "6.00",
      creditKind: "night",
      creditUnits: 2,
      validityDays: 365,
      isShopVisible: true,
      sortOrder: 50,
      prices: [{ amountCents: 18_000, validFromAt: from }],
    },
    {
      kind: "membership",
      sku: DEMO_SKUS.membershipMonthly,
      name: text("Maandlidmaatschap", "Abonnement mensuel", "Monthly membership"),
      description: text(
        "Vier dagsessies per maand inbegrepen en 10 % korting op extra sessies en nachten.",
        "Quatre séances de jour incluses par mois et 10 % de réduction sur les séances et nuits supplémentaires.",
        "Four day sessions included every month and 10% off extra sessions and nights.",
      ),
      vatRatePct: "21.00",
      recurringInterval: "month",
      includedCreditKind: "day",
      includedCreditUnits: 4,
      memberDiscountPct: "10.00",
      isShopVisible: true,
      sortOrder: 60,
      prices: [{ amountCents: 8_900, validFromAt: from }],
    },
    {
      kind: "ticket",
      sku: DEMO_SKUS.eventTicket,
      name: text("Ticket evenement", "Billet événement", "Event ticket"),
      description: text("Toegang tot één BEAM-evenement.", "Accès à un événement BEAM.", "Entry to one BEAM event."),
      vatRatePct: "21.00",
      isShopVisible: false,
      sortOrder: 70,
      prices: [{ amountCents: 2_500, validFromAt: from }],
    },
    {
      kind: "voucher",
      sku: DEMO_SKUS.giftVoucher,
      name: text("Cadeaubon", "Bon cadeau", "Gift voucher"),
      description: text(
        "Een cadeaubon van € 25 tot € 500, twee jaar geldig voor alles bij BEAM.",
        "Un bon cadeau de 25 € à 500 €, valable deux ans pour tout chez BEAM.",
        "A gift voucher from €25 to €500, valid for two years for everything at BEAM.",
      ),
      vatRatePct: "0.00",
      creditKind: "euro",
      validityDays: 730,
      isCustomAmount: true,
      minAmountCents: 2_500,
      maxAmountCents: 50_000,
      isShopVisible: true,
      sortOrder: 80,
      prices: [],
    },
    {
      kind: "item",
      sku: DEMO_SKUS.waterBottle,
      name: text("BEAM-drinkfles", "Gourde BEAM", "BEAM water bottle"),
      description: text(
        "Herbruikbare drinkfles van roestvrij staal, 500 ml.",
        "Gourde réutilisable en acier inoxydable, 500 ml.",
        "Reusable stainless steel water bottle, 500 ml.",
      ),
      vatRatePct: "21.00",
      itemCategory: "merchandise",
      isShopVisible: true,
      sortOrder: 90,
      prices: [{ amountCents: 1_900, validFromAt: from }],
    },
  ];
}

export type CommerceCatalogueResult = {
  /** Product id per SKU. */
  productIds: Record<string, string>;
  promotionIds: Record<string, string>;
  created: number;
};

/**
 * The demo catalogue: products (active, POS-visible), public price versions and the promotions
 * `WELKOM10` (10 %, first purchase, once per person) and the automatic December offer on the
 * 2-night package. Promotions need a staff author (`createdByUserId`); without one they are skipped.
 */
export async function seedCommerceCatalogue(db: DbOrTx, input: { now: Date; staffUserId: string | null }): Promise<CommerceCatalogueResult> {
  const productIds: Record<string, string> = {};
  const promotionIds: Record<string, string> = {};
  let created = 0;

  for (const { prices, ...values } of demoProducts(input.now)) {
    const inserted = await db
      .insert(products)
      .values({ ...values, isActive: true, isPosVisible: true })
      .onConflictDoNothing({ target: products.sku })
      .returning({ id: products.id });
    if (inserted[0]) created++;
    const [row] = await db.select({ id: products.id }).from(products).where(eq(products.sku, values.sku));
    productIds[values.sku] = row!.id;
    let version = 0;
    for (const p of prices) {
      version++;
      const added = await db
        .insert(priceVersions)
        .values({ productId: row!.id, version, audience: "public", amountCents: p.amountCents, validFromAt: p.validFromAt ?? input.now, validToAt: p.validToAt ?? null, reason: p.reason ?? null })
        .onConflictDoNothing()
        .returning({ id: priceVersions.id });
      if (added[0]) created++;
    }
  }

  if (input.staffUserId) {
    const welcome = await upsertPromotion(db, { code: "WELKOM10" }, {
      code: "WELKOM10",
      name: text("Welkomstkorting 10 %", "Réduction de bienvenue 10 %", "Welcome discount 10%"),
      kind: "percent",
      value: 10,
      appliesTo: { product_ids: [], product_kinds: [] },
      eligibility: { first_order_only: true },
      startsAt: new Date(input.now.getTime() - 90 * DAY),
      maxUsesPerPerson: 1,
      createdByUserId: input.staffUserId,
    });
    promotionIds.WELKOM10 = welcome.id;
    created += welcome.created ? 1 : 0;

    const year = input.now.getUTCFullYear();
    const winterName = text("Winternachten: € 20 korting", "Nuits d’hiver : 20 € de réduction", "Winter nights: €20 off");
    const winter = await upsertPromotion(db, { englishName: winterName.en! }, {
      code: null,
      name: winterName,
      kind: "fixed",
      value: 2_000,
      appliesTo: { product_ids: [productIds[DEMO_SKUS.package2Nights]!], product_kinds: [] },
      eligibility: {},
      startsAt: brusselsWinterMidnight(year, 12, 1),
      endsAt: brusselsWinterMidnight(year + 1, 1, 1),
      createdByUserId: input.staffUserId,
    });
    promotionIds["NIGHTS-WINTER"] = winter.id;
    created += winter.created ? 1 : 0;
  }

  return { productIds, promotionIds, created };
}

async function upsertPromotion(
  db: DbOrTx,
  key: { code: string } | { englishName: string },
  values: typeof promotions.$inferInsert,
): Promise<{ id: string; created: boolean }> {
  const where =
    "code" in key ? eq(promotions.code, key.code) : and(isNull(promotions.code), sql`${promotions.name}->>'en' = ${key.englishName}`);
  const [existing] = await db.select({ id: promotions.id }).from(promotions).where(where).limit(1);
  if (existing) return { id: existing.id, created: false };
  const [row] = await db.insert(promotions).values(values).returning({ id: promotions.id });
  return { id: row!.id, created: true };
}
