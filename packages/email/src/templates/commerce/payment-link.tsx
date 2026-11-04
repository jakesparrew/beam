/**
 * `commerce.payment_link` (commerce spec rule 41, section 6): the BEAM-hosted pay page link of one
 * order, sent by the job `payments.create_link` (key `pay_link:<order_id>:<version>`) when staff
 * send a payment link. The link stays the same while it is valid.
 */
import { z } from "zod";
import { t } from "@beam/core/i18n";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const PaymentLinkProps = z.object({
  /** `BO-XXXXXXXX`. */
  reference: z.string().min(1),
  /** The amount still due, formatted in the recipient's locale. */
  amount: z.string().min(1),
  /** `/[locale]/pay/<token>`, absolute. */
  payUrl: z.string().url(),
  /** The last day the link works, formatted. */
  validUntil: z.string().min(1),
});

export const paymentLinkSample: z.infer<typeof PaymentLinkProps> = {
  reference: "BO-7K3M9Q2X",
  amount: "€ 200,00",
  payUrl: "https://beam.example.com/nl/pay/3q2-7S0H8nX4b1fZk9cWm2pLr5tYv6uQe8aD0gJ1hKo",
  validUntil: "18 november 2026",
};

export function PaymentLink({ payUrl, validUntil, copy, locale }: TemplateComponentProps<typeof PaymentLinkProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.preheader}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.body}</EmailText>
      <EmailButton href={payUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
      <EmailText muted>{t(locale, "commerce.email.payment_link.valid_until", { date: validUntil })}</EmailText>
    </EmailLayout>
  );
}
