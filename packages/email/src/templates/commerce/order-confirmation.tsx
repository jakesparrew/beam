/**
 * `commerce.order_confirmation` (commerce spec rule 32, section 6): sent once per paid online,
 * admin, link and recurring order (key `order:<order_id>:receipt`) by the job
 * `commerce.render_receipt`, with the receipt PDF attached. Online orders with a package,
 * membership or voucher line carry the 14-day withdrawal notice and the link to the form (rule 54).
 */
import { z } from "zod";
import { t } from "@beam/core/i18n";
import { detailLabel, EmailButton, EmailHeading, EmailLayout, EmailLines, EmailNote, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const OrderConfirmationProps = z.object({
  /** `BO-XXXXXXXX`. */
  reference: z.string().min(1),
  /** The order total, formatted in the recipient's locale. */
  total: z.string().min(1),
  lines: z.array(z.object({ description: z.string().min(1), quantity: z.number().int().positive(), amount: z.string().min(1) })).min(1),
  /** The portal order page. */
  orderUrl: z.string().url(),
  /** Last day of the withdrawal right, formatted (online orders with a package, membership or voucher). */
  withdrawalUntil: z.string().min(1).optional(),
  withdrawalUrl: z.string().url().optional(),
});

export const orderConfirmationSample: z.infer<typeof OrderConfirmationProps> = {
  reference: "BO-7K3M9Q2X",
  total: "€ 200,00",
  lines: [{ description: "5-day package", quantity: 1, amount: "€ 200,00" }],
  orderUrl: "https://beam.example.com/nl/account/orders/6f1c1f9e-0b7a-4c39-9a51-0d2b6f6f3a11",
  withdrawalUntil: "18 november 2026",
  withdrawalUrl: "https://beam.example.com/nl/account/orders/6f1c1f9e-0b7a-4c39-9a51-0d2b6f6f3a11#withdrawal",
};

export function OrderConfirmation({ reference, total, lines, orderUrl, withdrawalUntil, withdrawalUrl, copy, locale }: TemplateComponentProps<typeof OrderConfirmationProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.preheader}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.body}</EmailText>
      <EmailLines title={`${detailLabel(locale, "reference")} ${reference}`} lines={lines} totalLabel={detailLabel(locale, "total_paid")} total={total} />
      {withdrawalUntil ? (
        <EmailNote>
          {t(locale, "commerce.email.order_confirmation.withdrawal", { date: withdrawalUntil })}
          {withdrawalUrl ? ` ${withdrawalUrl}` : ""}
        </EmailNote>
      ) : null}
      <EmailButton href={orderUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
