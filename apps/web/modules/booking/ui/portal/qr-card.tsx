"use client";
/**
 * The check-in card of `/[locale]/account/bookings/[id]` (booking spec 5.2, 6): the QR code for
 * reception as inline SVG (rendered on the server from the booking's check-in code, never a
 * stored or signed file) and "Add to calendar", an `.ics` file built in the browser. The SVG is
 * produced by the `qrcode` library on the server, so it holds no user input. Texts come from the
 * page.
 */
import { Button } from "@beam/ui";

export type QrCardEvent = { uid: string; title: string; startsAt: string; endsAt: string; location: string | null };

const stamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const escapeIcs = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** RFC 5545 text of one event (UTC times). */
export function icsText(e: QrCardEvent, now: Date = new Date()): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//BEAM//Booking//EN",
    "BEGIN:VEVENT",
    `UID:${e.uid}@beam`,
    `DTSTAMP:${stamp(now.toISOString())}`,
    `DTSTART:${stamp(e.startsAt)}`,
    `DTEND:${stamp(e.endsAt)}`,
    `SUMMARY:${escapeIcs(e.title)}`,
    ...(e.location ? [`LOCATION:${escapeIcs(e.location)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

export function QrCard({
  qrSvg,
  event,
  labels,
}: {
  /** Null when the viewer does not attend or the booking is no longer live. */
  qrSvg: string | null;
  event: QrCardEvent | null;
  labels: { qrLabel: string; hint: string; addToCalendar: string };
}) {
  function download() {
    if (!event) return;
    const blob = new Blob([icsText(event)], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "beam-booking.ics";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  if (!qrSvg && !event) return null;
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border p-4" data-testid="qr-card">
      {qrSvg ? (
        <>
          <div role="img" aria-label={labels.qrLabel} className="size-48 bg-white p-2 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: qrSvg }} />
          <p className="text-sm text-muted-foreground">{labels.hint}</p>
        </>
      ) : null}
      {event ? (
        <Button type="button" variant="outline" onClick={download} className="min-h-11">
          {labels.addToCalendar}
        </Button>
      ) : null}
    </div>
  );
}
