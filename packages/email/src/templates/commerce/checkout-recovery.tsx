/**
 * `commerce.checkout_recovery` (commerce spec rules 51 and 52, R2; cross-module D54): the reminder
 * of the seeded `abandoned-checkout` journey. Automation sends it as a marketing message (purpose
 * `newsletter`, rule 39a) from both steps, `remind_1h` (variant `first`) and `remind_24h`
 * (variant `second`), without `data`: `loadProps` (in `index.ts`) reads the checkout of
 * `context.checkout_id` and takes the resume link from `context.resume_url`, which automation got
 * from `commerce.getCheckoutRecoveryProps` (A-31a). The copy slots select on `variant`.
 */
import { z } from "zod";
import { t } from "@beam/core/i18n";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const RECOVERY_VARIANTS = ["first", "second"] as const;
export type RecoveryVariant = (typeof RECOVERY_VARIANTS)[number];

export const CheckoutRecoveryProps = z.object({
  variant: z.enum(RECOVERY_VARIANTS),
  /** The basket lines: the product name in the recipient's locale and the quantity. */
  items: z.array(z.object({ name: z.string().min(1), quantity: z.number().int().positive() })).min(1),
  /** The quote total at the last save, formatted in the recipient's locale. */
  total: z.string().min(1),
  /** `/[locale]/checkout/resume/<token>`, absolute. */
  resumeUrl: z.string().url(),
  checkoutId: z.uuid(),
});
export type CheckoutRecoveryProps = z.infer<typeof CheckoutRecoveryProps>;

export const checkoutRecoverySample: CheckoutRecoveryProps = {
  variant: "first",
  items: [
    { name: "5-dagenpakket", quantity: 1 },
    { name: "Cadeaubon", quantity: 2 },
  ],
  total: "€ 395,00",
  resumeUrl: "https://beam.example.com/nl/checkout/resume/q2K7S0H8nX4b1fZk9cWm2pLr5tYv6uQe8aD0gJ1hKoA",
  checkoutId: "00000000-0000-4000-8000-0000000000c8",
};

/** `remind_1h` is the first reminder; `remind_24h` (and any later step) the second. */
export function recoveryVariant(stepKey: string | null): RecoveryVariant {
  return stepKey === "remind_1h" || stepKey === null ? "first" : "second";
}

export function CheckoutRecovery({ items, total, resumeUrl, copy, locale }: TemplateComponentProps<typeof CheckoutRecoveryProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.preheader}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.body}</EmailText>
      {items.map((item, i) => (
        <EmailText key={`${i}-${item.name}`}>{t(locale, "commerce.email.checkout_recovery.line", { name: item.name, quantity: item.quantity })}</EmailText>
      ))}
      <EmailText>{t(locale, "commerce.email.checkout_recovery.total", { total })}</EmailText>
      <EmailButton href={resumeUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
      <EmailText muted>{copy.prices}</EmailText>
    </EmailLayout>
  );
}
