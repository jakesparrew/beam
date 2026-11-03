/**
 * finance contract stubs created by Wave 0 on behalf of finance (platform-P2): `invoices` and
 * `invoice_sequences` with their architecture columns (data model 1.2.6). finance takes the
 * file over and adds the "(addition)" columns, checks and indexes, leaving these columns'
 * type, nullability and default as they are (frozen contract columns).
 */
import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { orders } from "./commerce";
import { persons } from "./crm";
import { id, money, timestamps, tstz } from "./_shared";
import { files } from "./platform";

export const invoicesKind = pgEnum("invoices_kind", ["invoice", "credit_note"]);
export const invoicesStatus = pgEnum("invoices_status", [
  "issued",
  "paid",
  "open",
  "cancelled",
]);
export const invoicesBillitStatus = pgEnum("invoices_billit_status", [
  "pending",
  "synced",
  "failed",
]);

export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    kind: invoicesKind().notNull(),
    number: text().notNull().unique(),
    reversesInvoiceId: uuid().references((): AnyPgColumn => invoices.id),
    orderId: uuid()
      .notNull()
      .references(() => orders.id),
    personId: uuid().references(() => persons.id, { onDelete: "restrict" }),
    // FK to companies is added by finance once crm creates the table (Wave 1).
    companyId: uuid(),
    customerSnapshot: jsonb().notNull(),
    lines: jsonb().notNull(),
    subtotalCents: money().notNull(),
    vatCents: money().notNull(),
    totalCents: money().notNull(),
    vatBreakdown: jsonb().notNull(),
    issuedOn: date().notNull(),
    dueOn: date(),
    status: invoicesStatus().notNull(),
    pdfFileId: uuid().references(() => files.id),
    billitId: text().unique("invoices_billit_id_unique"),
    billitStatus: invoicesBillitStatus().notNull().default("pending"),
    billitSyncedAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    index("ix_invoices_issued_on").on(t.issuedOn, t.kind),
    index("ix_invoices_order").on(t.orderId),
    index("ix_invoices_reverses").on(t.reversesInvoiceId),
    check(
      "chk_invoices_total",
      sql`${t.totalCents} = ${t.subtotalCents} + ${t.vatCents}`,
    ),
  ],
);

export const invoiceSequences = pgTable(
  "invoice_sequences",
  {
    id: id(),
    kind: invoicesKind().notNull(),
    year: smallint().notNull(),
    lastNumber: integer().notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("invoice_sequences_year_kind_uq").on(t.year, t.kind),
    check("chk_invoice_sequences_year", sql`${t.year} between 2026 and 2100`),
    check("chk_invoice_sequences_last_number", sql`${t.lastNumber} >= 0`),
  ],
);
