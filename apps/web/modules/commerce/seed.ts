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
 */
import { files, lightspeedImports, lightspeedSales, users } from "@beam/db/schema";
import { seedCommerceCatalogue } from "@beam/db/seed/commerce";
import { and, asc, eq } from "@/lib/ctx";
import { storeFile } from "@/lib/files";
import { businessDayRange, parseLightspeedCsv } from "../../../../packages/core/src/commerce/lightspeed";
import type { SeedCtx } from "@/scripts/seed-demo";

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

export const seed = {
  after: ["forms"],
  run: async (s: SeedCtx): Promise<void> => {
    const result = await seedCommerceCatalogue(s.db, { now: s.now, staffUserId: await staffAuthor(s) });
    for (const [sku, id] of Object.entries(result.productIds)) s.ids.set(`commerce.product.${sku}`, id);
    for (const [code, id] of Object.entries(result.promotionIds)) s.ids.set(`commerce.promotion.${code}`, id);
    await seedLightspeedDemo(s, await staffAuthor(s));
  },
};
