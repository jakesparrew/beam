/**
 * The order receipt PDF (commerce spec rules 44 and 54, section 8; commerce-P4a). Rendered by the
 * job `commerce.render_receipt` into `files` (kind `receipt`) and attached to the order
 * confirmation. One locale per receipt (`orders.locale`), never a mixed language: a missing
 * catalogue key throws `PermanentError` (the job goes dead and alerts). VAT is listed per rate;
 * online orders with a withdrawal right carry the notice with its deadline.
 *
 * `loadReceiptInput` reads the order, `receiptModel` resolves every text (pure, tested) and
 * `renderReceiptPdf` lays the model out with `@react-pdf/renderer`.
 */
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { orderLines, orders, payments } from "@beam/db/schema";
import { PermanentError } from "@beam/core/errors";
import { formatDate, formatMoney, lookupMessage, MESSAGES, pick, type Locale, type LocalizedText } from "@beam/core/i18n";
import { and, eq, inArray, type DbOrTx } from "@/lib/ctx";
import { getSetting } from "@/lib/settings";
import { commerceSettings, PAID_PAYMENT_STATUSES } from "../server/paid";

export type ReceiptLineInput = {
  description: LocalizedText;
  quantity: number;
  unitAmountCents: number;
  discountCents: number;
  lineTotalCents: number;
  vatRatePct: number;
  vatCents: number;
};

export type ReceiptInput = {
  reference: string;
  locale: Locale;
  issuedAt: Date;
  company: { name: string; legalName: string; vatNumber: string; address: string; email: string };
  lines: ReceiptLineInput[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  payments: { method: string; amountCents: number }[];
  withdrawalUntilAt: Date | null;
  footer: LocalizedText;
};

export type ReceiptModel = {
  title: string;
  header: string[];
  meta: { label: string; value: string }[];
  columns: { description: string; quantity: string; vat: string; amount: string };
  rows: { description: string; quantity: string; vat: string; amount: string; discount: string | null }[];
  totals: { label: string; value: string }[];
  vatTitle: string;
  vatRows: { rate: string; net: string; vat: string; gross: string }[];
  vatColumns: { rate: string; net: string; vat: string; gross: string };
  paidWith: { label: string; value: string }[];
  paidWithTitle: string;
  withdrawal: string | null;
  footer: string;
};

const PAYMENT_METHOD_KEYS = new Set(["bancontact", "creditcard", "kbc", "belfius", "ideal", "paypal", "pointofsale", "cash", "banktransfer", "credit_balance", "directdebit"]);

/** `commerce.receipt.<key>` in `locale`; a missing message is permanent (section 8). */
function label(locale: Locale, key: string, params?: Record<string, string | number>): string {
  const full = `commerce.receipt.${key}`;
  const message = lookupMessage(MESSAGES, locale, full);
  if (message === undefined || message.trim() === "") throw new PermanentError(`missing_translation: ${locale} ${full}`);
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (_m, name: string) => String(params[name] ?? ""));
}

/** Gross, VAT and net per VAT rate, ascending by rate. */
export function vatSummary(lines: readonly Pick<ReceiptLineInput, "vatRatePct" | "lineTotalCents" | "vatCents">[]): { ratePct: number; grossCents: number; vatCents: number; netCents: number }[] {
  const byRate = new Map<number, { grossCents: number; vatCents: number }>();
  for (const l of lines) {
    const r = byRate.get(l.vatRatePct) ?? { grossCents: 0, vatCents: 0 };
    r.grossCents += l.lineTotalCents;
    r.vatCents += l.vatCents;
    byRate.set(l.vatRatePct, r);
  }
  return [...byRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ratePct, r]) => ({ ratePct, grossCents: r.grossCents, vatCents: r.vatCents, netCents: r.grossCents - r.vatCents }));
}

/** Every text of the receipt in the order's locale. */
export function receiptModel(input: ReceiptInput): ReceiptModel {
  const { locale } = input;
  const money = (c: number) => formatMoney(c, locale);
  const rate = (pct: number) => label(locale, "vat_rate", { rate: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(pct) });
  const totalVat = input.lines.reduce((s, l) => s + l.vatCents, 0);
  const totals = [{ label: label(locale, "subtotal"), value: money(input.subtotalCents) }];
  if (input.discountCents > 0) totals.push({ label: label(locale, "discount"), value: `- ${money(input.discountCents)}` });
  totals.push({ label: label(locale, "total"), value: money(input.totalCents) });
  totals.push({ label: label(locale, "vat_included"), value: money(totalVat) });
  return {
    title: label(locale, "title"),
    header: [input.company.name, input.company.legalName, input.company.address, label(locale, "vat_number", { number: input.company.vatNumber }), input.company.email].filter((s) => s.trim() !== ""),
    meta: [
      { label: label(locale, "reference"), value: input.reference },
      { label: label(locale, "date"), value: formatDate(input.issuedAt, locale, "long") },
    ],
    columns: { description: label(locale, "col_description"), quantity: label(locale, "col_quantity"), vat: label(locale, "col_vat"), amount: label(locale, "col_amount") },
    rows: input.lines.map((l) => ({
      description: pick(l.description, locale, "order_lines.description"),
      quantity: String(l.quantity),
      vat: rate(l.vatRatePct),
      amount: money(l.lineTotalCents),
      discount: l.discountCents > 0 ? label(locale, "line_discount", { amount: money(l.discountCents) }) : null,
    })),
    totals,
    vatTitle: label(locale, "vat_summary"),
    vatColumns: { rate: label(locale, "col_vat"), net: label(locale, "net"), vat: label(locale, "vat_amount"), gross: label(locale, "gross") },
    vatRows: vatSummary(input.lines).map((v) => ({ rate: rate(v.ratePct), net: money(v.netCents), vat: money(v.vatCents), gross: money(v.grossCents) })),
    paidWithTitle: label(locale, "paid_with"),
    paidWith: input.payments.map((p) => ({
      label: label(locale, `method_${PAYMENT_METHOD_KEYS.has(p.method) ? p.method : "other"}`),
      value: money(p.amountCents),
    })),
    withdrawal: input.withdrawalUntilAt ? label(locale, "withdrawal", { date: formatDate(input.withdrawalUntilAt, locale, "long") }) : null,
    footer: pick(input.footer, locale, "settings.commerce.receipt_footer"),
  };
}

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 10, fontFamily: "Helvetica", color: "#1f2933" },
  title: { fontSize: 18, marginBottom: 12, fontFamily: "Helvetica-Bold" },
  small: { fontSize: 9, color: "#52606d" },
  row: { flexDirection: "row", paddingVertical: 3 },
  head: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#9aa5b1", paddingBottom: 3, marginTop: 14, fontFamily: "Helvetica-Bold" },
  desc: { flexGrow: 1, flexBasis: 0 },
  qty: { width: 40, textAlign: "right" },
  vat: { width: 70, textAlign: "right" },
  amount: { width: 80, textAlign: "right" },
  section: { marginTop: 14 },
  notice: { marginTop: 16, padding: 8, borderWidth: 1, borderColor: "#9aa5b1" },
});

function ReceiptDocument({ model }: { model: ReceiptModel }) {
  return (
    <Document title={model.title}>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>{model.title}</Text>
        {model.header.map((h) => (
          <Text key={h} style={styles.small}>
            {h}
          </Text>
        ))}
        <View style={styles.section}>
          {model.meta.map((m) => (
            <Text key={m.label}>{`${m.label}: ${m.value}`}</Text>
          ))}
        </View>
        <View style={styles.head}>
          <Text style={styles.desc}>{model.columns.description}</Text>
          <Text style={styles.qty}>{model.columns.quantity}</Text>
          <Text style={styles.vat}>{model.columns.vat}</Text>
          <Text style={styles.amount}>{model.columns.amount}</Text>
        </View>
        {model.rows.map((r, i) => (
          <View key={i} style={styles.row}>
            <Text style={styles.desc}>{r.discount ? `${r.description}\n${r.discount}` : r.description}</Text>
            <Text style={styles.qty}>{r.quantity}</Text>
            <Text style={styles.vat}>{r.vat}</Text>
            <Text style={styles.amount}>{r.amount}</Text>
          </View>
        ))}
        <View style={styles.section}>
          {model.totals.map((t) => (
            <View key={t.label} style={styles.row}>
              <Text style={styles.desc}>{t.label}</Text>
              <Text style={styles.amount}>{t.value}</Text>
            </View>
          ))}
        </View>
        <View style={styles.head}>
          <Text style={styles.desc}>{model.vatTitle}</Text>
          <Text style={styles.vat}>{model.vatColumns.net}</Text>
          <Text style={styles.vat}>{model.vatColumns.vat}</Text>
          <Text style={styles.amount}>{model.vatColumns.gross}</Text>
        </View>
        {model.vatRows.map((v) => (
          <View key={v.rate} style={styles.row}>
            <Text style={styles.desc}>{v.rate}</Text>
            <Text style={styles.vat}>{v.net}</Text>
            <Text style={styles.vat}>{v.vat}</Text>
            <Text style={styles.amount}>{v.gross}</Text>
          </View>
        ))}
        {model.paidWith.length ? (
          <View style={styles.section}>
            <Text style={{ fontFamily: "Helvetica-Bold" }}>{model.paidWithTitle}</Text>
            {model.paidWith.map((p, i) => (
              <View key={i} style={styles.row}>
                <Text style={styles.desc}>{p.label}</Text>
                <Text style={styles.amount}>{p.value}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {model.withdrawal ? <Text style={styles.notice}>{model.withdrawal}</Text> : null}
        <Text style={[styles.small, { marginTop: 24 }]}>{model.footer}</Text>
      </Page>
    </Document>
  );
}

/** The PDF bytes of a receipt. */
export async function renderReceiptPdf(input: ReceiptInput): Promise<Uint8Array> {
  const model = receiptModel(input);
  const buffer = await renderToBuffer(<ReceiptDocument model={model} />);
  return new Uint8Array(buffer);
}

/** Reads what a receipt shows: the order, its lines, its paid payments and the company setting. */
export async function loadReceiptInput(db: DbOrTx, orderId: string): Promise<ReceiptInput | null> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return null;
  const lines = await db.select().from(orderLines).where(eq(orderLines.orderId, orderId)).orderBy(orderLines.lineNo);
  const paid = await db
    .select({ method: payments.method, provider: payments.provider, amountCents: payments.amountCents })
    .from(payments)
    .where(and(eq(payments.orderId, orderId), inArray(payments.status, [...PAID_PAYMENT_STATUSES])));
  const company = await getSetting(db, "company").catch(() => null);
  const settings = await commerceSettings(db);
  const address = company ? [company.address.street, [company.address.postal_code, company.address.city].filter(Boolean).join(" ")].filter((s) => s.trim() !== "").join(", ") : "";
  return {
    reference: order.reference,
    locale: order.locale as Locale,
    issuedAt: order.paidAt ?? order.createdAt,
    company: {
      name: company?.trade_name ?? "BEAM Vitality Center",
      legalName: company?.legal_name ?? "",
      vatNumber: company?.vat_number ?? "",
      address,
      email: company?.support_email ?? "",
    },
    lines: lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitAmountCents: l.unitAmountCents,
      discountCents: l.discountCents,
      lineTotalCents: l.lineTotalCents,
      vatRatePct: Number(l.vatRatePct),
      vatCents: l.vatCents,
    })),
    subtotalCents: order.subtotalCents,
    discountCents: order.discountCents,
    totalCents: order.totalCents,
    payments: paid.map((p) => ({ method: p.method ?? (p.provider === "credit_balance" ? "credit_balance" : p.provider === "cash" ? "cash" : "other"), amountCents: p.amountCents })),
    withdrawalUntilAt: order.withdrawalUntilAt,
    footer: settings.receipt_footer,
  };
}
