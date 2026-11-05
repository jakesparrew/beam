/**
 * commerce's demo seed (runbook 6.3), run by `apps/web/scripts/seed-demo.ts` in `after` order. Facade
 * read by `pnpm gen:indexes`.
 *
 * commerce-P3 seeds the catalogue of runbook 6.3 through `seedCommerceCatalogue` from
 * `@beam/db/seed/commerce`: nine products with their price versions (the 10-day package has two,
 * €360 until 1 October and €380 since) and the promotions `WELKOM10` and the automatic December
 * offer on the 2-night package, authored by the demo owner (or the first staff user). Ids are
 * recorded as `commerce.product.<sku>` and `commerce.promotion.<code>`. The paid orders, the
 * expired order, the abandoned checkout and the refund of runbook 6.3 need `createOrder` and the
 * paid transaction, so the order packages (commerce-P4a onwards) add them here.
 *
 * commerce-P9 (R3) adds one demo Lightspeed import (`lightspeed-demo.csv`, kind `import`) with
 * food-and-drink lines for the three days before today, imported at once (status `done`), so
 * `/admin/pos/lightspeed` and `v_lightspeed_daily` show figures. It runs once: an existing
 * import of that file name is left alone.
 *
 * ops-P10 request: paid orders for crm's non-tester demo customers (`seedDemoCustomerOrders`),
 * through the real order and paid-transaction code, found again on a rerun by their `client_key`.
 */
import { createHash } from "node:crypto";
import type { Tx } from "@beam/db";
import { files, lightspeedImports, lightspeedSales, orders, payments, persons, products, users } from "@beam/db/schema";
import { DEMO_SKUS, seedCommerceCatalogue } from "@beam/db/seed/commerce";
import { businessDayRange, parseLightspeedCsv } from "@beam/core/commerce";
import type { Locale } from "@beam/core/i18n";
import { and, asc, createCtx, eq } from "@/lib/ctx";
import { storeFile } from "@/lib/files";
import type { SeedCtx } from "@/scripts/seed-demo";
import { createOrder } from "./server/orders";
import { finalizePaidOrder } from "./server/paid";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function staffAuthor(s: SeedCtx): Promise<string | null> {
  const owner = s.ids.get("platform.user.owner");
  if (owner) return owner;
  const [row] = await s.db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.audience, "staff"), eq(users.status, "active")))
    .orderBy(asc(users.createdAt))
    .limit(1);
  return row?.id ?? null;
}

const DEMO_FILE = "lightspeed-demo.csv";
const DEMO_ITEMS: ReadonlyArray<[string, string, string, number]> = [
  ["Cappuccino", "Warme dranken", "21", 380],
  ["Kruidenthee", "Warme dranken", "21", 320],
  ["Smoothie", "Koude dranken", "6", 650],
  ["Soep van de dag", "Keuken", "12", 850],
  ["Quiche", "Keuken", "12", 1350],
];

/** `YYYY-MM-DD` of the Brussels day `n` days before `now` (the seed's day start). */
function dayBefore(now: Date, n: number): string {
  const d = new Date(now.getTime() - n * 86_400_000 + 12 * 3_600_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** The demo CSV: semicolons and decimal commas, like a Belgian Lightspeed export. */
export function demoLightspeedCsv(now: Date): string {
  const lines = ["Bonnummer;Lijn;Datum;Product;Categorie;Aantal;Totaal incl. btw;Btw %;Betaalmethode"];
  for (const n of [3, 2, 1]) {
    const [y, m, d] = dayBefore(now, n).split("-");
    for (let r = 0; r < 4; r++) {
      const receipt = `LS-${y}${m}${d}-${String(r + 1).padStart(3, "0")}`;
      for (let l = 0; l < 2; l++) {
        const [name, category, vat, cents] = DEMO_ITEMS[(n + r + l) % DEMO_ITEMS.length]!;
        const qty = 1 + ((r + l) % 2);
        const total = (cents * qty) / 100;
        lines.push([receipt, l + 1, `${d}/${m}/${y} ${String(10 + r * 2).padStart(2, "0")}:15`, name, category, qty, total.toFixed(2).replace(".", ","), vat, r % 2 ? "Cash" : "Bancontact"].join(";"));
      }
    }
  }
  return lines.join("\r\n");
}

async function seedLightspeedDemo(s: SeedCtx, staffUserId: string | null): Promise<void> {
  if (!staffUserId) return;
  const [existing] = await s.db
    .select({ id: lightspeedImports.id })
    .from(lightspeedImports)
    .innerJoin(files, eq(files.id, lightspeedImports.fileId))
    .where(eq(files.name, DEMO_FILE))
    .limit(1);
  if (existing) {
    s.ids.set("commerce.lightspeed_import.demo", existing.id);
    return;
  }
  const csv = demoLightspeedCsv(s.now);
  const { rows, errors } = parseLightspeedCsv(csv);
  const { fileId } = await storeFile(s.ctx, { kind: "import", name: DEMO_FILE, mime: "text/csv", bytes: new TextEncoder().encode(csv) });
  const range = businessDayRange(rows);
  const [imp] = await s.db
    .insert(lightspeedImports)
    .values({
      fileId,
      status: "done",
      businessFromOn: range?.from ?? null,
      businessToOn: range?.to ?? null,
      rowsTotal: rows.length + errors.length,
      createdByUserId: staffUserId,
    })
    .returning({ id: lightspeedImports.id });
  const inserted = rows.length
    ? await s.db
        .insert(lightspeedSales)
        .values(rows.map((r) => ({ importId: imp!.id, externalLineKey: r.externalLineKey, businessDayOn: r.businessDayOn, soldAt: r.soldAt, receiptNumber: r.receiptNumber, productName: r.productName, category: r.category, quantity: r.quantity, totalCents: r.totalCents, vatRatePct: r.vatRatePct, vatCents: r.vatCents, paymentMethod: r.paymentMethod })))
        .onConflictDoNothing({ target: lightspeedSales.externalLineKey })
        .returning({ id: lightspeedSales.id })
    : [];
  await s.db
    .update(lightspeedImports)
    .set({ rowsImported: inserted.length, rowsSkipped: rows.length + errors.length - inserted.length })
    .where(eq(lightspeedImports.id, imp!.id));
  s.ids.set("commerce.lightspeed_import.demo", imp!.id);
}

/**
 * ops-P10 request: paid orders of crm's non-tester demo customers (`crm.customer.<slug>`), spread
 * over the last three months, so reports and the `ai` schema show revenue. An Verbruggen buys
 * the 10-session package (PKG-10-DAYS). Each order runs the real path: `createOrder` (channel
 * `admin`) at the order's day, a paid desk-terminal payment, then the paid transaction
 * (`finalizePaidOrder`: credits granted through credits, the invoice through finance).
 */
export const DEMO_CUSTOMER_ORDERS: readonly { customer: string; sku: string; quantity: number; daysAgo: number; method: string }[] = [
  { customer: "an-verbruggen", sku: DEMO_SKUS.package10Days, quantity: 1, daysAgo: 62, method: "bancontact" },
  { customer: "an-verbruggen", sku: DEMO_SKUS.waterBottle, quantity: 1, daysAgo: 20, method: "bancontact" },
  { customer: "koen-de-wilde", sku: DEMO_SKUS.package5Days, quantity: 1, daysAgo: 75, method: "creditcard" },
  { customer: "koen-de-wilde", sku: DEMO_SKUS.package5Days, quantity: 1, daysAgo: 18, method: "creditcard" },
  { customer: "sarah-lenaerts", sku: DEMO_SKUS.package2Nights, quantity: 1, daysAgo: 48, method: "bancontact" },
  { customer: "julie-moreau", sku: DEMO_SKUS.package5Days, quantity: 1, daysAgo: 33, method: "bancontact" },
  { customer: "marc-gerard", sku: DEMO_SKUS.waterBottle, quantity: 2, daysAgo: 26, method: "cash" },
  { customer: "hannah-clarke", sku: DEMO_SKUS.package2Nights, quantity: 1, daysAgo: 9, method: "creditcard" },
];

/** A stable UUID for a demo name (the order's `client_key`), so a rerun finds the same order. */
export function demoUuid(name: string): string {
  const h = createHash("sha256").update(`beam-demo:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function seedDemoCustomerOrders(s: Pick<SeedCtx, "db" | "now" | "ids">): Promise<{ created: number; skipped: number }> {
  const tx = s.db as Tx;
  let created = 0;
  let skipped = 0;
  for (const [i, o] of DEMO_CUSTOMER_ORDERS.entries()) {
    const personId = s.ids.get(`crm.customer.${o.customer}`);
    const [product] = await tx.select({ id: products.id }).from(products).where(eq(products.sku, o.sku));
    const [person] = personId ? await tx.select({ locale: persons.locale }).from(persons).where(eq(persons.id, personId)) : [];
    if (!personId || !product || !person) {
      skipped++;
      continue;
    }
    // 11:00 Brussels-ish on the order's day (the seed's `now` is the start of a Brussels day).
    const at = new Date(s.now.getTime() - o.daysAgo * DAY + 10 * HOUR);
    const ctx = createCtx({ tx, actor: { kind: "system", jobId: "seed:commerce" }, requestId: "seed:commerce", now: at, durableMode: "immediate" });
    const order = await createOrder(tx, ctx, {
      personId,
      channel: "admin",
      items: [{ productId: product.id, quantity: o.quantity }],
      clientKey: demoUuid(`order:${o.customer}:${i + 1}`),
      locale: person.locale as Locale,
    });
    if (order.status !== "pending_payment") {
      skipped++;
      continue;
    }
    await tx.update(orders).set({ createdAt: new Date(at.getTime() - 5 * 60_000) }).where(eq(orders.id, order.orderId));
    const [payment] = await tx
      .insert(payments)
      .values({ orderId: order.orderId, provider: o.method === "cash" ? "cash" : "terminal", method: o.method, status: "paid", amountCents: order.totalCents, paidAt: at })
      .returning({ id: payments.id });
    await finalizePaidOrder(tx, ctx, order.orderId, { paymentId: payment!.id });
    s.ids.set(`commerce.order.${o.customer}.${i + 1}`, order.orderId);
    created++;
  }
  return { created, skipped };
}

export const seed = {
  after: ["forms"],
  run: async (s: SeedCtx): Promise<void> => {
    const result = await seedCommerceCatalogue(s.db, { now: s.now, staffUserId: await staffAuthor(s) });
    for (const [sku, id] of Object.entries(result.productIds)) s.ids.set(`commerce.product.${sku}`, id);
    for (const [code, id] of Object.entries(result.promotionIds)) s.ids.set(`commerce.promotion.${code}`, id);
    await seedLightspeedDemo(s, await staffAuthor(s));
    await seedDemoCustomerOrders(s);
  },
};
