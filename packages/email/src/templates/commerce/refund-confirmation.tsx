/**
 * `commerce.refund_confirmation` (commerce spec rule 39, section 6): sent once per refund when it
 * reaches `refunded` (key `refund:<refund_id>:confirmation`): staff refunds, withdrawals,
 * cancellations refunded through `refundOrderLine` and seats lost after a late payment.
 */
import { z } from "zod";
import { detailLabel, EmailButton, EmailDetails, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const RefundConfirmationProps = z.object({
  /** `BO-XXXXXXXX`. */
  reference: z.string().min(1),
  /** The refunded amount, formatted in the recipient's locale. */
  amount: z.string().min(1),
  /** The portal order page. */
  orderUrl: z.string().url(),
});

export const refundConfirmationSample: z.infer<typeof RefundConfirmationProps> = {
  reference: "BO-7K3M9Q2X",
  amount: "€ 45,00",
  orderUrl: "https://beam.example.com/nl/account/orders/6f1c1f9e-0b7a-4c39-9a51-0d2b6f6f3a11",
};

export function RefundConfirmation({ reference, amount, orderUrl, copy, locale }: TemplateComponentProps<typeof RefundConfirmationProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.preheader}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.body}</EmailText>
      <EmailDetails rows={[{ label: detailLabel(locale, "reference"), value: reference }, { label: detailLabel(locale, "amount"), value: amount, strong: true }]} />
      <EmailButton href={orderUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
