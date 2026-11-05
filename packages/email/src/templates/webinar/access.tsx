/**
 * `webinar.access` (webinar spec rules 14, 18, 19, section 8): the registration confirmation with
 * the personal access link. Sent by `registerPerson` at once (and again, at most three times an
 * hour, when the person registers again or asks for the link), always in the registration's
 * locale. Shows the date in Brussels time and the spoken language, links "Add to calendar" to the
 * public `.ics` route and attaches the same `.ics` file (`attachments` in `index.ts`). The `.ics`
 * carries the landing URL, never the personal link. An on-demand webinar has no date and no
 * calendar entry.
 */
import { z } from "zod";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

export const AccessProps = z.object({
  /** Webinar title in the registration's locale. */
  title: z.string().min(1),
  /** Start formatted in the recipient's locale (Europe/Brussels); empty for on-demand. */
  date: z.string(),
  /** The spoken language, named in the recipient's locale ("Nederlands", "French"). */
  language: z.string().min(1),
  /** The personal access link `/<l>/w/<token>`. */
  accessUrl: z.string().url(),
  /** The public landing page (also the `.ics` URL field). */
  landingUrl: z.string().url(),
  /** `/api/public/webinars/<slug>/ics?locale=<l>`; null for on-demand. */
  icsUrl: z.string().url().nullable(),
  /** ISO instants for the `.ics` attachment; null for on-demand. */
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  webinarId: z.uuid(),
  registrationId: z.uuid(),
});
export type AccessProps = z.infer<typeof AccessProps>;

export function Access({ date, accessUrl, icsUrl, copy, locale }: TemplateComponentProps<typeof AccessProps>) {
  return (
    <EmailLayout locale={locale} preheader={copy.preheader}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{date ? copy.intro : copy.intro_on_demand}</EmailText>
      <EmailText>{copy.language}</EmailText>
      <EmailButton href={accessUrl} locale={locale}>
        {copy.cta}
      </EmailButton>
      <EmailText muted>{copy.personal}</EmailText>
      {icsUrl ? (
        <EmailText>
          <a href={icsUrl}>{copy.calendar}</a>
        </EmailText>
      ) : null}
    </EmailLayout>
  );
}

// ---------------------------------------------------------------------------------------------
// The `.ics` calendar entry (section 8: UTC times plus `TZID=Europe/Brussels` metadata)
// ---------------------------------------------------------------------------------------------

export type WebinarIcsInput = {
  /** Stable per webinar, so a second import updates the same calendar entry. */
  webinarId: string;
  title: string;
  description?: string;
  startsAt: Date | string;
  endsAt: Date | string;
  /** The public landing page; never the personal access link. */
  url: string;
  /** DTSTAMP; defaults to now. */
  stamp?: Date;
};

const icsDate = (d: Date | string) =>
  (d instanceof Date ? d : new Date(d))
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

/** RFC 5545 text escaping. */
const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/([,;])/g, "\\$1");

/** RFC 5545 line folding at 75 octets (approximated by characters, safe for the ASCII we emit). */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [line.slice(0, 75)];
  for (let i = 75; i < line.length; i += 74) parts.push(` ${line.slice(i, i + 74)}`);
  return parts.join("\r\n");
}

/** A one-event `VCALENDAR` (UTC instants, `X-WR-TIMEZONE:Europe/Brussels`). */
export function buildWebinarIcs(input: WebinarIcsInput): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//BEAM Vitality Center//Webinar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-TIMEZONE:Europe/Brussels",
    "BEGIN:VEVENT",
    `UID:webinar-${input.webinarId}@beam.be`,
    `DTSTAMP:${icsDate(input.stamp ?? new Date())}`,
    `DTSTART:${icsDate(input.startsAt)}`,
    `DTEND:${icsDate(input.endsAt)}`,
    `SUMMARY:${icsText(input.title)}`,
    ...(input.description ? [`DESCRIPTION:${icsText(`${input.description}\n${input.url}`)}`] : [`DESCRIPTION:${icsText(input.url)}`]),
    `URL:${input.url}`,
    `LOCATION:${icsText(input.url)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
