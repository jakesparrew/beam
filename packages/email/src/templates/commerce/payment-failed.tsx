/**
 * `commerce.payment_failed` (commerce spec rule 33): a payment ended `failed`, `expired` or
 * `cancelled` on an order that can still be paid (key `payment:<payment_id>:failed`). Not for
 * renewal orders (credits sends its own reminder) and not for POS sales.
 */
import { z } from "zod";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const PaymentFailedProps = z.object({
  reference: z.string().min(1),
  /** The payment amount, formatted in the recipient's locale. */
  amount: z.string().min(1),
  /** The order payment page, where the customer tries again. */
  retryUrl: z.string().url(),
});

export const paymentFailedSample: z.infer<typeof PaymentFailedProps> = {
  reference: "BO-7K3M9Q2X",
  amount: "€ 45,00",
  retryUrl: "https://beam.example.com/nl/account/checkout/6f1c1f9e-0b7a-4c39-9a51-0d2b6f6f3a11",
};

export function PaymentFailed({ retryUrl, copy, locale }: TemplateComponentProps<typeof PaymentFailedProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.preheader}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.body}</EmailText>
      <EmailButton href={retryUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
