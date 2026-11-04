/**
 * finance-P1 schema test (finance spec section 12): tables and views exist, the Wave 0 columns
 * of `invoices` and `invoice_sequences` are unchanged, one live invoice per order, the checks
 * of section 2.2, the V1 views, the guard trigger SQL and the defaults seed.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makePerson, makeProduct, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import {
  billitParties,
  billitReconcileRuns,
  financeExports,
  invoiceRequests,
  invoices,
  invoiceSequences,
  orderBillingDetails,
  orders,
  settings,
  vFinanceBillitBacklog,
  vFinanceInvoiceLines,
  vFinanceOpenInvoices,
  vFinanceVatSummary,
  vInvoiceBalances,
} from "@beam/db/schema";
import { seed as financeSeed } from "@beam/db/seed/finance";
import {
  ANONYMISED_SNAPSHOT,
  buildSellerSnapshot,
  buildVatBreakdown,
  CompanySettingSchema,
  computeLineVat,
  documentTotals,
  FINANCE_SETTING_DEFAULT,
  FinanceSettingSchema,
  formatNumber,
  INVOICES_GUARD_TRIGGER_SQL,
  reduceSnapshot,
  structuredCommunication,
  walkInSnapshot,
  type CustomerSnapshot,
  type InvoiceKind,
  type InvoiceLine,
  type InvoiceStatus,
} from "@beam/core/finance";
import { eq, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";

/** The Postgres error behind a failed query. */
async function pgError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause ?? (error as { message?: string });
    return String(cause.message ?? error);
  }
  throw new Error("expected the query to fail");
}

let h: DbHandle;
let personId: string;
let userId: string;
let productId: string;
beforeAll(async () => {
  h = await createTestDb();
  personId = (await makePerson(h.db)).id;
  userId = (await makeUser(h.db)).id;
  productId = (await makeProduct(h.db, { kind: "package" })).id;
});
afterAll(() => h.close());

async function makeOrder(totalCents = 12_100) {
  const [row] = await h.db
    .insert(orders)
    .values({ personId, channel: "admin", subtotalCents: totalCents, vatCents: 0, totalCents, locale: "nl-BE", clientKey: randomUUID() })
    .returning();
  return row!;
}

const COMPANY = CompanySettingSchema.parse({
  legal_name: "Vibrant Lifestyle Collective BV",
  trade_name: "BEAM Vitality Center",
  vat_number: "BE0123456749",
  enterprise_number: "0123.456.749",
  address: { street: "Teststraat 1", postal_code: "9000", city: "Gent", country: "BE" },
  support_email: "support@demo.beam.be",
  phone: "",
  website: "",
});

function line(gross: number, rate: 0 | 6 | 12 | 21 = 21, sign = 1): InvoiceLine {
  const { vatCents, netCents } = computeLineVat(sign * gross, rate);
  return {
    order_line_id: randomUUID(),
    product_id: productId,
    sku: "PKG-5",
    category: "package",
    description: "Pakket 5 dagen",
    description_i18n: { "nl-BE": "Pakket 5 dagen", "fr-BE": "Forfait 5 jours", en: "5-day package" },
    quantity: sign,
    unit_amount_cents: gross,
    discount_cents: 0,
    discount_label: null,
    line_total_cents: sign * gross,
    vat_rate_pct: rate,
    vat_cents: vatCents,
    net_cents: netCents,
    vat_note: rate === 0 ? "Btw verschuldigd bij inwisseling." : null,
    credit_kind: null,
    credit_units: null,
    session_starts_at: null,
  };
}

const seqs: Record<string, number> = {};
type InvoiceOver = Partial<typeof invoices.$inferInsert> & { kind?: InvoiceKind; status?: InvoiceStatus; lines?: InvoiceLine[] };

function invoiceValues(orderId: string, over: InvoiceOver = {}): typeof invoices.$inferInsert {
  const kind = over.kind ?? "invoice";
  const lines = over.lines ?? [line(12_100)];
  const totals = documentTotals(lines);
  const n = over.sequenceNumber ?? (seqs[kind] = (seqs[kind] ?? 0) + 1);
  const snapshot: CustomerSnapshot = {
    kind: "person",
    name: "Test Person",
    email: "person@example.com",
    phone: null,
    address: null,
    vat_number: null,
    peppol_id: null,
    purchase_order_ref: null,
    person_id: personId,
    company_id: null,
    is_reduced: false,
  };
  return {
    kind,
    number: formatNumber(kind, 2026, n),
    fiscalYear: 2026,
    sequenceNumber: n,
    orderId,
    personId,
    locale: "nl-BE",
    customerSnapshot: snapshot,
    sellerSnapshot: buildSellerSnapshot(COMPANY, FINANCE_SETTING_DEFAULT, "nl-BE"),
    lines,
    ...totals,
    vatBreakdown: buildVatBreakdown(lines),
    issuedOn: "2026-11-04",
    status: kind === "invoice" ? "paid" : "issued",
    paidAt: kind === "invoice" ? new Date("2026-11-04T10:00:00Z") : null,
    reason: kind === "credit_note" ? "Refund" : null,
    issuedBy: { kind: "system", id: null },
    ...over,
  };
}

async function insertInvoice(orderId: string, over: InvoiceOver = {}) {
  const [row] = await h.db.insert(invoices).values(invoiceValues(orderId, over)).returning();
  return row!;
}

describe("finance tables and views", () => {
  it("creates every V1 table and view", async () => {
    const names = rowsOf<{ name: string }>(
      await h.db.execute(sql`select table_name as name from information_schema.tables where table_schema = 'public' and table_name in
        ('invoices', 'invoice_sequences', 'order_billing_details', 'invoice_requests', 'billit_parties', 'billit_reconcile_runs', 'finance_exports',
         'v_invoice_balances', 'v_finance_invoice_lines', 'v_finance_vat_summary', 'v_finance_open_invoices', 'v_finance_billit_backlog')`),
    ).map((r) => r.name);
    expect(names.sort()).toEqual(
      [
        "billit_parties",
        "billit_reconcile_runs",
        "finance_exports",
        "invoice_requests",
        "invoice_sequences",
        "invoices",
        "order_billing_details",
        "v_finance_billit_backlog",
        "v_finance_invoice_lines",
        "v_finance_open_invoices",
        "v_finance_vat_summary",
        "v_invoice_balances",
      ].sort(),
    );
  });

  it("keeps the Wave 0 columns of invoices and invoice_sequences unchanged", async () => {
    const cols = rowsOf<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      await h.db.execute(sql`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name in ('invoices', 'invoice_sequences')`),
    );
    const col = (t: string, c: string) => cols.find((r) => r.table_name === t && r.column_name === c);
    const wave0: [string, string, string, "YES" | "NO", RegExp | null][] = [
      ["invoices", "id", "uuid", "NO", /gen_random_uuid/],
      ["invoices", "kind", "USER-DEFINED", "NO", null],
      ["invoices", "number", "text", "NO", null],
      ["invoices", "reverses_invoice_id", "uuid", "YES", null],
      ["invoices", "order_id", "uuid", "NO", null],
      ["invoices", "person_id", "uuid", "YES", null],
      ["invoices", "company_id", "uuid", "YES", null],
      ["invoices", "customer_snapshot", "jsonb", "NO", null],
      ["invoices", "lines", "jsonb", "NO", null],
      ["invoices", "subtotal_cents", "integer", "NO", null],
      ["invoices", "vat_cents", "integer", "NO", null],
      ["invoices", "total_cents", "integer", "NO", null],
      ["invoices", "vat_breakdown", "jsonb", "NO", null],
      ["invoices", "issued_on", "date", "NO", null],
      ["invoices", "due_on", "date", "YES", null],
      ["invoices", "status", "USER-DEFINED", "NO", null],
      ["invoices", "pdf_file_id", "uuid", "YES", null],
      ["invoices", "billit_id", "text", "YES", null],
      ["invoices", "billit_status", "USER-DEFINED", "NO", /'pending'/],
      ["invoices", "billit_synced_at", "timestamp with time zone", "YES", null],
      ["invoices", "created_at", "timestamp with time zone", "NO", /now\(\)/],
      ["invoices", "updated_at", "timestamp with time zone", "NO", /now\(\)/],
      ["invoice_sequences", "id", "uuid", "NO", /gen_random_uuid/],
      ["invoice_sequences", "kind", "USER-DEFINED", "NO", null],
      ["invoice_sequences", "year", "smallint", "NO", null],
      ["invoice_sequences", "last_number", "integer", "NO", /^0$/],
      ["invoice_sequences", "created_at", "timestamp with time zone", "NO", /now\(\)/],
      ["invoice_sequences", "updated_at", "timestamp with time zone", "NO", /now\(\)/],
    ];
    for (const [table, column, type, nullable, def] of wave0) {
      const c = col(table, column);
      expect(c, `${table}.${column}`).toBeDefined();
      expect(c!.data_type, `${table}.${column} type`).toBe(type);
      expect(c!.is_nullable, `${table}.${column} nullability`).toBe(nullable);
      if (def) expect(c!.column_default ?? "", `${table}.${column} default`).toMatch(def);
      else expect(c!.column_default, `${table}.${column} default`).toBeNull();
    }
  });

  it("allows one live invoice per order; a cancelled one makes room for the reissue", async () => {
    const order = await makeOrder();
    const first = await insertInvoice(order.id);
    expect(await pgError(insertInvoice(order.id))).toMatch(/uq_invoices_order_live/);
    await h.db.update(invoices).set({ status: "cancelled" }).where(eq(invoices.id, first.id));
    const reissue = await insertInvoice(order.id, { replacesInvoiceId: first.id });
    expect(reissue.replacesInvoiceId).toBe(first.id);
  });

  it("numbers are unique per kind and year; refunds and payment references once", async () => {
    const order = await makeOrder();
    const a = await insertInvoice(order.id, { status: "open", paidAt: null, dueOn: "2026-11-18", paymentReference: structuredCommunication(2026, 900) });
    const other = await makeOrder();
    expect(await pgError(insertInvoice(other.id, { sequenceNumber: a.sequenceNumber }))).toMatch(/unique|duplicate/i);
    expect(await pgError(insertInvoice(other.id, { status: "open", paidAt: null, dueOn: "2026-11-18", paymentReference: a.paymentReference }))).toMatch(
      /uq_invoices_payment_reference/,
    );
  });
});

describe("invoices checks", () => {
  it("refuses a credit note with a positive total or positive VAT", async () => {
    const order = await makeOrder();
    const inv = await insertInvoice(order.id);
    expect(await pgError(insertInvoice(order.id, { kind: "credit_note", reversesInvoiceId: inv.id, lines: [line(1_210)] }))).toMatch(
      /chk_invoices_kind_amounts|chk_invoices_vat_sign/,
    );
    expect(
      await pgError(
        insertInvoice(order.id, { kind: "credit_note", reversesInvoiceId: inv.id, lines: [line(1_210, 21, -1)], subtotalCents: -1_210, vatCents: 210, totalCents: -1_000 }),
      ),
    ).toMatch(/chk_invoices_vat_sign/);
    const ok = await insertInvoice(order.id, { kind: "credit_note", reversesInvoiceId: inv.id, lines: [line(1_210, 21, -1)] });
    expect(ok.totalCents).toBe(-1_210);
    expect(ok.vatCents).toBe(-210);
  });

  it("refuses an open invoice without due date and an invoice with status issued", async () => {
    const order = await makeOrder();
    expect(await pgError(insertInvoice(order.id, { status: "open", paidAt: null, dueOn: null }))).toMatch(/chk_invoices_open_due/);
    expect(await pgError(insertInvoice(order.id, { status: "issued" }))).toMatch(/chk_invoices_status_kind/);
  });

  it("refuses a credit note without reason or original, and a paid document without paid_at", async () => {
    const order = await makeOrder();
    const inv = await insertInvoice(order.id);
    const cn = { kind: "credit_note" as const, reversesInvoiceId: inv.id, lines: [line(1_210, 21, -1)] };
    expect(await pgError(insertInvoice(order.id, { ...cn, reason: null }))).toMatch(/chk_invoices_reason/);
    expect(await pgError(insertInvoice(order.id, { ...cn, reason: "x " }))).toMatch(/chk_invoices_reason/);
    expect(await pgError(insertInvoice(order.id, { ...cn, reversesInvoiceId: null }))).toMatch(/chk_invoices_reverses/);
    const other = await makeOrder();
    expect(await pgError(insertInvoice(other.id, { paidAt: null }))).toMatch(/chk_invoices_paid_at/);
  });

  it("refuses a number that does not match kind, year and sequence", async () => {
    const order = await makeOrder();
    expect(await pgError(insertInvoice(order.id, { number: "CN-2026-000777", sequenceNumber: 777 }))).toMatch(/chk_invoices_number/);
    expect(await pgError(insertInvoice(order.id, { number: "BEAM-2026-000778", sequenceNumber: 779 }))).toMatch(/chk_invoices_number_format/);
    expect(await pgError(insertInvoice(order.id, { fiscalYear: 2027, number: "BEAM-2027-000780", sequenceNumber: 780 }))).toMatch(/chk_invoices_fiscal_year/);
  });

  it("requires a person, a company, or a reduced, anonymised or walk-in snapshot", async () => {
    const snapshot = invoiceValues(randomUUID()).customerSnapshot;
    const noParty = { personId: null, companyId: null };
    expect(await pgError(insertInvoice((await makeOrder()).id, { ...noParty, customerSnapshot: { ...snapshot, person_id: null } }))).toMatch(
      /chk_invoices_party/,
    );
    await insertInvoice((await makeOrder()).id, { ...noParty, customerSnapshot: walkInSnapshot("Walk-in customer") });
    await insertInvoice((await makeOrder()).id, { ...noParty, customerSnapshot: reduceSnapshot(snapshot) });
    await insertInvoice((await makeOrder()).id, { ...noParty, customerSnapshot: ANONYMISED_SNAPSHOT });
  });

  it("refuses an empty line list and a currency other than EUR", async () => {
    expect(await pgError(insertInvoice((await makeOrder()).id, { lines: [], subtotalCents: 0, vatCents: 0, totalCents: 0, vatBreakdown: [] }))).toMatch(
      /chk_invoices_lines/,
    );
    expect(await pgError(insertInvoice((await makeOrder()).id, { currency: "USD" }))).toMatch(/chk_invoices_currency/);
  });
});

describe("supporting tables", () => {
  it("invoice_sequences: one row per year and kind, years 2026 to 2100", async () => {
    await h.db.insert(invoiceSequences).values({ kind: "invoice", year: 2030 });
    expect(await pgError(h.db.insert(invoiceSequences).values({ kind: "invoice", year: 2030 }))).toMatch(/invoice_sequences_year_kind_uq/);
    expect(await pgError(h.db.insert(invoiceSequences).values({ kind: "invoice", year: 2025 }))).toMatch(/chk_invoice_sequences_year/);
  });

  it("order_billing_details: a company needs a VAT number, one row per order", async () => {
    const order = await makeOrder();
    const address = { line1: "Kerkstraat 1", postal_code: "9000", city: "Gent", country: "BE" };
    expect(await pgError(h.db.insert(orderBillingDetails).values({ orderId: order.id, isCompany: true, legalName: "Acme BV", address }))).toMatch(
      /chk_obd_company_vat/,
    );
    expect(await pgError(h.db.insert(orderBillingDetails).values({ orderId: order.id, legalName: " A ", address }))).toMatch(/chk_obd_legal_name/);
    await h.db.insert(orderBillingDetails).values({ orderId: order.id, isCompany: true, legalName: "Acme BV", vatNumber: "BE0123456749", address });
    expect(await pgError(h.db.insert(orderBillingDetails).values({ orderId: order.id, legalName: "Acme BV", address }))).toMatch(/unique/i);
  });

  it("invoice_requests: one pending request per invoice", async () => {
    const inv = await insertInvoice((await makeOrder()).id);
    const billing = {
      isCompany: true,
      legalName: "Acme BV",
      vatNumber: "BE0123456749",
      address: { line1: "Kerkstraat 1", postal_code: "9000", city: "Gent", country: "BE" },
    };
    const [first] = await h.db.insert(invoiceRequests).values({ invoiceId: inv.id, personId, billing }).returning();
    expect(await pgError(h.db.insert(invoiceRequests).values({ invoiceId: inv.id, personId, billing }))).toMatch(/uq_invoice_requests_pending/);
    expect(await pgError(h.db.update(invoiceRequests).set({ status: "rejected" }).where(eq(invoiceRequests.id, first!.id)))).toMatch(
      /chk_invoice_requests_decided/,
    );
    await h.db.update(invoiceRequests).set({ status: "rejected", decidedAt: new Date(), decidedByUserId: userId }).where(eq(invoiceRequests.id, first!.id));
    await h.db.insert(invoiceRequests).values({ invoiceId: inv.id, personId, billing });
  });

  it("billit_parties, billit_reconcile_runs and finance_exports", async () => {
    await h.db.insert(billitParties).values([{ partyKey: "walk_in" }, { partyKey: `person:${personId}`, personId }, { partyKey: "vat:BE0123456749" }]);
    expect(await pgError(h.db.insert(billitParties).values({ partyKey: "walk_in" }))).toMatch(/unique/i);
    expect(await pgError(h.db.insert(billitParties).values({ partyKey: "someone" }))).toMatch(/chk_billit_parties_key/);
    const [run] = await h.db.insert(billitReconcileRuns).values({ runOn: "2026-11-04", startedAt: new Date(), status: "ok" }).returning();
    expect(run!.issues).toEqual([]);
    expect(await pgError(h.db.insert(billitReconcileRuns).values({ runOn: "2026-11-04", startedAt: new Date(), status: "ok" }))).toMatch(/unique/i);
    const base = { kind: "invoices" as const, requestedByUserId: userId };
    const [exp] = await h.db.insert(financeExports).values({ ...base, periodFrom: "2028-01-01", periodTo: "2028-12-31" }).returning();
    expect(exp!.status).toBe("queued");
    expect(await pgError(h.db.insert(financeExports).values({ ...base, periodFrom: "2026-01-01", periodTo: "2027-01-02" }))).toMatch(
      /chk_finance_exports_period/,
    );
    expect(await pgError(h.db.insert(financeExports).values({ ...base, periodFrom: "2026-02-01", periodTo: "2026-01-01" }))).toMatch(
      /chk_finance_exports_period/,
    );
  });
});

describe("V1 views", () => {
  it("balances, lines, VAT summary, open invoices and the Billit backlog", async () => {
    const order = await makeOrder(13_420);
    const l21 = line(12_100, 21);
    const l6 = line(1_060, 6);
    const l0 = line(260, 0);
    const inv = await insertInvoice(order.id, {
      lines: [l21, l6, l0],
      status: "open",
      paidAt: null,
      dueOn: "2026-10-01",
      issuedOn: "2026-09-17",
      paymentReference: structuredCommunication(2026, 901),
    });
    const credit = { ...line(1_060, 6, -1), order_line_id: l6.order_line_id };
    const cn = await insertInvoice(order.id, { kind: "credit_note", reversesInvoiceId: inv.id, lines: [credit], issuedOn: "2026-09-20" });

    const [balance] = await h.db.select().from(vInvoiceBalances).where(eq(vInvoiceBalances.invoiceId, inv.id));
    expect(balance).toEqual({ invoiceId: inv.id, totalCents: 13_420, creditedCents: 1_060, remainingCents: 12_360, isFullyCredited: false });

    const lines = await h.db.select().from(vFinanceInvoiceLines).where(eq(vFinanceInvoiceLines.invoiceId, inv.id));
    expect(lines).toHaveLength(3);
    expect(lines.reduce((s, l) => s + (l.vatCents ?? 0), 0)).toBe(inv.vatCents);
    const cnLines = await h.db.select().from(vFinanceInvoiceLines).where(eq(vFinanceInvoiceLines.invoiceId, cn.id));
    expect(cnLines[0]).toMatchObject({ kind: "credit_note", lineTotalCents: -1_060, vatCents: -60, netCents: -1_000 });

    const summary = await h.db.select().from(vFinanceVatSummary).where(eq(vFinanceVatSummary.month, "2026-09-01"));
    const row = (kind: string, rate: number) => summary.find((s) => s.kind === kind && Number(s.vatRatePct) === rate);
    expect(row("invoice", 21)).toMatchObject({ quarter: 3, fiscalYear: 2026, netCents: 10_000, vatCents: 2_100, grossCents: 12_100 });
    expect(row("invoice", 0)).toMatchObject({ vatCents: 0, grossCents: 260 });
    expect(row("credit_note", 6)).toMatchObject({ netCents: -1_000, vatCents: -60, grossCents: -1_060 });

    const [open] = await h.db.select().from(vFinanceOpenInvoices).where(eq(vFinanceOpenInvoices.id, inv.id));
    expect(open).toMatchObject({ number: inv.number, customerName: "Test Person", totalCents: 13_420, amountDueCents: 12_360, dueOn: "2026-10-01" });
    expect(open!.daysOverdue).toBeGreaterThan(0);

    const backlog = await h.db.select().from(vFinanceBillitBacklog).where(eq(vFinanceBillitBacklog.id, inv.id));
    expect(backlog[0]).toMatchObject({ kind: "invoice", billitStatus: "pending", billitAttempts: 0, failingMinutes: null });
  });

  it("a fully credited invoice has nothing remaining", async () => {
    const order = await makeOrder();
    const l = line(12_100);
    const inv = await insertInvoice(order.id, { lines: [l] });
    await insertInvoice(order.id, { kind: "credit_note", reversesInvoiceId: inv.id, lines: [{ ...line(12_100, 21, -1), order_line_id: l.order_line_id }] });
    const [b] = await h.db.select().from(vInvoiceBalances).where(eq(vInvoiceBalances.invoiceId, inv.id));
    expect(b).toMatchObject({ remainingCents: 0, isFullyCredited: true });
  });
});

describe("INVOICES_GUARD_TRIGGER_SQL", () => {
  it("guards frozen columns, transitions and rewrites", async () => {
    // Multi-statement SQL (function plus triggers), as the custom migration runs it.
    await (h.db as unknown as { $client: { exec(text: string): Promise<unknown> } }).$client.exec(INVOICES_GUARD_TRIGGER_SQL);
    const inv = await insertInvoice((await makeOrder()).id, { status: "open", paidAt: null, dueOn: "2026-11-18" });
    const upd = (set: Partial<typeof invoices.$inferInsert>) => h.db.update(invoices).set(set).where(eq(invoices.id, inv.id));

    expect(await pgError(upd({ totalCents: 1 }))).toMatch(/invoice_immutable: .*total_cents/);
    expect(await pgError(upd({ number: "BEAM-2026-099999" }))).toMatch(/invoice_immutable/);
    expect(await pgError(upd({ personId: null }))).toMatch(/invoice_immutable: person_id/);
    expect(await pgError(h.db.delete(invoices).where(eq(invoices.id, inv.id)))).toMatch(/invoice_immutable: delete/);

    await upd({ billitStatus: "failed", billitAttempts: 1, pdfStatus: "failed" });
    await upd({ sellerSnapshot: buildSellerSnapshot(COMPANY, FINANCE_SETTING_DEFAULT, "en") });
    await upd({ status: "paid", paidAt: new Date(), settledVia: "manual", paymentMethod: "bank_transfer" });
    expect(await pgError(upd({ paymentMethod: "cash" }))).toMatch(/payment columns/);
    expect(await pgError(upd({ status: "open" }))).toMatch(/not a valid transition/);
    await upd({ pdfStatus: "rendered" });
    expect(await pgError(upd({ sellerSnapshot: buildSellerSnapshot(COMPANY, FINANCE_SETTING_DEFAULT, "fr-BE") }))).toMatch(/seller_snapshot/);

    const tamper = h.db.transaction(async (tx) => {
      await tx.execute(sql`set local beam.allow_rewrite = 'on'`);
      await tx.update(invoices).set({ customerSnapshot: { ...inv.customerSnapshot, name: "x" } }).where(eq(invoices.id, inv.id));
    });
    expect(await pgError(tamper)).toMatch(/customer_snapshot/);
    await h.db.transaction(async (tx) => {
      await tx.execute(sql`set local beam.allow_rewrite = 'on'`);
      await tx.update(invoices).set({ personId: null, customerSnapshot: reduceSnapshot(inv.customerSnapshot) }).where(eq(invoices.id, inv.id));
      await tx.update(invoices).set({ customerSnapshot: ANONYMISED_SNAPSHOT, pdfFileId: null }).where(eq(invoices.id, inv.id));
    });
    const [after] = await h.db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(after!.customerSnapshot).toEqual({ anonymised: true });
    expect(after!.personId).toBeNull();
  });
});

describe("defaults seed", () => {
  it("seeds the finance settings row once, valid against FinanceSettingSchema", async () => {
    await financeSeed.run(h.db, {});
    await financeSeed.run(h.db, {});
    const rows = await h.db.select().from(settings).where(eq(settings.key, "finance"));
    expect(rows).toHaveLength(1);
    const value = FinanceSettingSchema.parse(rows[0]!.value);
    expect(value.issuer).toMatchObject({ register_court: "", iban: "", bic: "" });
    expect(Object.keys(value.vat_notes.voucher ?? {}).sort()).toEqual(["en", "fr-BE", "nl-BE"]);
    expect(financeSeed.after).toEqual(["platform"]);
  });
});
