/**
 * The gift-voucher PDF (commerce spec rules 45, 45a and section 8; commerce-P6). Rendered by the
 * job `commerce.issue_voucher_email` (`files.kind = receipt`) and attached to the
 * `commerce.gift_voucher` email. One locale per voucher (the order's locale); a missing catalogue
 * key throws `PermanentError` (the job goes dead and alerts), never a mixed language.
 *
 * `voucherModel` resolves every text (pure, tested); `renderVoucherPdf` lays it out with
 * `@react-pdf/renderer`.
 */
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { PermanentError } from "@beam/core/errors";
import { formatDate, formatMoney, lookupMessage, MESSAGES, type Locale } from "@beam/core/i18n";

export type VoucherPdfInput = {
  locale: Locale;
  /** The derived code `BEAM-XXXX-XXXX-XXXX` (never stored, rule 45). */
  code: string;
  amountCents: number;
  recipientName: string | null;
  message: string | null;
  expiresAt: Date;
  redeemUrl: string;
};

export type VoucherModel = {
  title: string;
  greeting: string | null;
  amount: string;
  codeLabel: string;
  code: string;
  message: string | null;
  validUntil: string;
  howTo: string;
  url: string;
};

/** `commerce.voucher.<key>` in `locale`; a missing message is permanent (section 8). */
function label(locale: Locale, key: string, params?: Record<string, string | number>): string {
  const full = `commerce.voucher.${key}`;
  const message = lookupMessage(MESSAGES, locale, full);
  if (message === undefined || message.trim() === "") throw new PermanentError(`missing_translation: ${locale} ${full}`);
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (_m, name: string) => String(params[name] ?? ""));
}

export function voucherModel(input: VoucherPdfInput): VoucherModel {
  const { locale } = input;
  return {
    title: label(locale, "pdf_title"),
    greeting: input.recipientName?.trim() ? label(locale, "pdf_greeting", { name: input.recipientName.trim() }) : null,
    amount: formatMoney(input.amountCents, locale),
    codeLabel: label(locale, "pdf_code"),
    code: input.code,
    message: input.message?.trim() || null,
    validUntil: label(locale, "pdf_valid_until", { date: formatDate(input.expiresAt, locale, "long") }),
    howTo: label(locale, "pdf_how_to"),
    url: input.redeemUrl,
  };
}

const styles = StyleSheet.create({
  page: { padding: 48, fontSize: 12, fontFamily: "Helvetica", color: "#1f2933" },
  title: { fontSize: 26, fontFamily: "Helvetica-Bold", marginBottom: 16 },
  amount: { fontSize: 40, fontFamily: "Helvetica-Bold", marginVertical: 24 },
  box: { borderWidth: 1, borderColor: "#1f2933", padding: 16, marginVertical: 16 },
  code: { fontSize: 22, fontFamily: "Courier-Bold", letterSpacing: 2 },
  small: { fontSize: 10, color: "#52606d", marginTop: 8 },
  message: { fontStyle: "italic", marginVertical: 12 },
});

function VoucherDocument({ model }: { model: VoucherModel }) {
  return (
    <Document title={model.title}>
      <Page size="A5" orientation="landscape" style={styles.page}>
        <Text style={styles.title}>{model.title}</Text>
        {model.greeting ? <Text>{model.greeting}</Text> : null}
        <Text style={styles.amount}>{model.amount}</Text>
        {model.message ? <Text style={styles.message}>{model.message}</Text> : null}
        <View style={styles.box}>
          <Text style={styles.small}>{model.codeLabel}</Text>
          <Text style={styles.code}>{model.code}</Text>
        </View>
        <Text>{model.validUntil}</Text>
        <Text style={styles.small}>{model.howTo}</Text>
        <Text style={styles.small}>{model.url}</Text>
      </Page>
    </Document>
  );
}

/** The PDF bytes of a gift voucher. */
export async function renderVoucherPdf(input: VoucherPdfInput): Promise<Uint8Array> {
  const buffer = await renderToBuffer(<VoucherDocument model={voucherModel(input)} />);
  return new Uint8Array(buffer);
}
