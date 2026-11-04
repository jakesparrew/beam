/**
 * `commerce.pos_receipt` (commerce spec rules 32 and 44, section 6): the receipt of a paid POS
 * order, sent once to a buyer with an email address (key `order:<order_id>:receipt`) by the job
 * `commerce.render_receipt`, and again from the POS or the order screen (`emailReceipt`, key
 * `order:<order_id>:receipt:<n>`), always with the receipt PDF attached. POS sales carry no
 * withdrawal right (rule 54), so the email has no withdrawal notice.
 */
import { Section } from "react-email";
import { z } from "zod";
import { t } from "@beam/core/i18n";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const PosReceiptProps = z.object({
  /** `BO-XXXXXXXX`. */
  reference: z.string().min(1),
  /** The order total, formatted in the recipient's locale. */
  total: z.string().min(1),
  lines: z.array(z.object({ description: z.string().min(1), quantity: z.number().int().positive(), amount: z.string().min(1) })).min(1),
  /** The portal order page (a buyer without a portal account is asked to sign in first). */
  orderUrl: z.string().url(),
});

export const posReceiptSample: z.infer<typeof PosReceiptProps> = {
  reference: "BO-4H8N2R7T",
  total: "€ 75,00",
  lines: [
    { description: "Day session · 4 Nov 2026, 10:00", quantity: 1, amount: "€ 45,00" },
    { description: "Water bottle", quantity: 1, amount: "€ 30,00" },
  ],
  orderUrl: "https://beam.example.com/nl/account/orders/6f1c1f9e-0b7a-4c39-9a51-0d2b6f6f3a11",
};

export function PosReceipt({ total, lines, orderUrl, copy, locale }: TemplateComponentProps<typeof PosReceiptProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.preheader}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.body}</EmailText>
      <Section style={{ margin: "8px 0 16px" }}>
        {lines.map((l, i) => (
          <EmailText key={i}>{`${l.quantity} × ${l.description}: ${l.amount}`}</EmailText>
        ))}
        <EmailText>{t(locale, "commerce.email.pos_receipt.total", { total })}</EmailText>
      </Section>
      <EmailButton href={orderUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
