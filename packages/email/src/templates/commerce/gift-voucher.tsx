/**
 * `commerce.gift_voucher` (commerce spec rules 45 and 45a, section 6): the gift voucher with its
 * code, sent by the job `commerce.issue_voucher_email` (key `voucher:<voucher_id>:email:<n>`) to
 * the recipient, or the purchaser when no recipient address was given, with the voucher PDF
 * attached. A chosen delivery date sends it at 09:00 Brussels that day (`sendAt`).
 */
import { Section } from "react-email";
import { z } from "zod";
import { t } from "@beam/core/i18n";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const GiftVoucherProps = z.object({
  /** `BEAM-XXXX-XXXX-XXXX`, derived again for every send (never stored). */
  code: z.string().min(1),
  /** The voucher value, formatted in the order's locale. */
  amount: z.string().min(1),
  recipientName: z.string().max(120),
  /** The purchaser's personal message (may be empty). */
  message: z.string().max(500),
  /** The expiry date, formatted. */
  validUntil: z.string().min(1),
  /** Where the code is redeemed (portal). */
  redeemUrl: z.string().url(),
});

export const giftVoucherSample: z.infer<typeof GiftVoucherProps> = {
  code: "BEAM-7K3M-9Q2X-4F8T",
  amount: "€ 50,00",
  recipientName: "Alex",
  message: "Enjoy a quiet afternoon!",
  validUntil: "4 november 2028",
  redeemUrl: "https://beam.example.com/nl/account/orders#redeem",
};

export function GiftVoucher({ code, recipientName, message, validUntil, redeemUrl, copy, locale }: TemplateComponentProps<typeof GiftVoucherProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.preheader}>
      <EmailHeading>{recipientName ? `${copy.heading}, ${recipientName}` : copy.heading}</EmailHeading>
      <EmailText>{copy.body}</EmailText>
      {message ? <EmailText muted>{message}</EmailText> : null}
      <Section style={{ margin: "8px 0 16px" }}>
        <EmailText>{`${t(locale, "commerce.email.gift_voucher.code_label")}: ${code}`}</EmailText>
        <EmailText muted>{t(locale, "commerce.email.gift_voucher.valid_until", { date: validUntil })}</EmailText>
      </Section>
      <EmailButton href={redeemUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
