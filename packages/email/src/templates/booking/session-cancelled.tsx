/**
 * `booking.session_cancelled` (booking spec R33, R59): BEAM cancelled the session. `refunded`
 * adds the refund line (a paid order line), `creditReleased` the "back in your package" line.
 */
import { z } from "zod";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const SessionCancelledProps = z.object({
  title: z.string().min(1),
  date: z.string().min(1),
  url: z.string().url(),
  refunded: z.boolean().default(false),
  creditReleased: z.boolean().default(false),
});

export function SessionCancelled({ url, refunded, creditReleased, copy, locale }: TemplateComponentProps<typeof SessionCancelledProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.intro}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.intro}</EmailText>
      {refunded ? <EmailText>{copy.refunded}</EmailText> : null}
      {creditReleased ? <EmailText>{copy.credit_released}</EmailText> : null}
      <EmailButton href={url} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}
