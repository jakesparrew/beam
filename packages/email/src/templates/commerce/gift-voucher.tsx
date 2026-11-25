/**
 * `commerce.gift_voucher` (commerce spec rules 45 and 45a, section 6): the gift voucher with its
 * code, sent by the job `commerce.issue_voucher_email` (key `voucher:<voucher_id>:email:<n>`) to
 * the recipient, or the purchaser when no recipient address was given, with the voucher PDF
 * attached. A chosen delivery date sends it at 09:00 Brussels that day (`sendAt`).
 */
import { Img, Section, Text } from "react-email";
import { z } from "zod";
import { t } from "@beam/core/i18n";
import { BRAND, EMAIL_IMAGES, EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
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

export function GiftVoucher({ code, amount, recipientName, message, validUntil, redeemUrl, copy, locale }: TemplateComponentProps<typeof GiftVoucherProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.preheader} hero="welcome">
      <EmailHeading>{recipientName ? `${copy.heading}, ${recipientName}` : copy.heading}</EmailHeading>
      <EmailText>{copy.body}</EmailText>
      {message ? (
        <Text style={{ color: BRAND.text, fontFamily: BRAND.serifFont, fontSize: "18px", lineHeight: "28px", fontStyle: "italic", borderLeft: `3px solid ${BRAND.accent}`, padding: "2px 0 2px 16px", margin: "0 0 24px" }}>
          {`“${message}”`}
        </Text>
      ) : null}
      <Section style={{ backgroundColor: BRAND.header, borderRadius: "16px", padding: "28px 28px 24px", margin: "4px 0 28px", textAlign: "center" }}>
        <Img src={EMAIL_IMAGES.logoHeader} alt="" width="150" height="30" style={{ display: "block", margin: "0 auto 18px", border: 0 }} />
        <Text style={{ color: BRAND.accent, fontFamily: BRAND.font, fontSize: "12px", letterSpacing: "0.2em", textTransform: "uppercase", margin: "0 0 6px" }}>
          {t(locale, "platform.email.layout.gift_title")}
        </Text>
        <Text style={{ color: "#ffffff", fontFamily: BRAND.headingFont, fontSize: "40px", lineHeight: "48px", fontWeight: 500, margin: "0 0 16px" }}>{amount}</Text>
        <Img src={EMAIL_IMAGES.goldLine} alt="" width="200" height="2" style={{ display: "block", margin: "0 auto 16px", border: 0 }} />
        <Text style={{ color: "#c9c2b4", fontFamily: BRAND.font, fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 4px" }}>
          {t(locale, "commerce.email.gift_voucher.code_label")}
        </Text>
        <Text style={{ color: "#ffffff", fontFamily: "'Courier New', Courier, monospace", fontSize: "20px", letterSpacing: "0.08em", fontWeight: 700, margin: "0 0 14px" }}>{code}</Text>
        <Text style={{ color: "#c9c2b4", fontFamily: BRAND.font, fontSize: "13px", margin: 0 }}>{t(locale, "commerce.email.gift_voucher.valid_until", { date: validUntil })}</Text>
      </Section>
      <EmailButton href={redeemUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
