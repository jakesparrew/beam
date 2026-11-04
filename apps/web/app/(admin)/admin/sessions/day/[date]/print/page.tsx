import { notFound } from "next/navigation";
import { brusselsTime } from "@beam/core/booking";
import { formatDate, formatMoney, type Locale, type LocalizedText } from "@beam/core/i18n";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getDayPrintList } from "@/modules/booking/queries";

const show = (text: LocalizedText | null | undefined, locale: Locale) => text?.[locale] || text?.["nl-BE"] || text?.en || text?.["fr-BE"] || "";

/**
 * `/admin/sessions/day/[date]/print` (`bookings.read`, booking spec 5.1, R62b): one A4 table per
 * session (time, name, guest of, paid with, to pay, terms pending, health declaration, notes)
 * with a print stylesheet and no navigation: the reception's fallback when the network is down.
 */
export default async function SessionDayPrintPage({ params }: { params: Promise<{ date: string }> }) {
  await requireStaff({ permission: "bookings.read" });
  const { date } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const list = await getDayPrintList(db, { onDate: date });
  const yes = "✓";

  return (
    <div className="grid gap-6 bg-background text-foreground print:text-black">
      <style>{`@media print { @page { size: A4; margin: 12mm; } nav, header, aside, [data-admin-nav] { display: none !important; } .print-break { break-after: page; } }`}</style>
      <h1 className="text-2xl font-semibold">{tr("booking.print.title", { date: formatDate(date, locale, "full") })}</h1>
      {list.sessions.length === 0 ? <p>{tr("booking.print.empty")}</p> : null}
      {list.sessions.map((s, i) => (
        <section key={s.sessionId} className={i < list.sessions.length - 1 ? "print-break grid gap-2" : "grid gap-2"} aria-labelledby={`s-${s.sessionId}`}>
          <h2 id={`s-${s.sessionId}`} className="text-lg font-semibold">
            {brusselsTime(s.startsAt)}–{brusselsTime(s.endsAt)} · {show(s.title, locale)}
            {s.location ? ` · ${s.location}` : ""}
            {s.status === "closed" ? ` · ${tr("booking.day.close_session")}` : ""}
          </h2>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="py-1 pr-2">{tr("booking.print.time")}</th>
                <th className="py-1 pr-2">{tr("booking.print.name")}</th>
                <th className="py-1 pr-2">{tr("booking.print.guest_of")}</th>
                <th className="py-1 pr-2">{tr("booking.print.paid_with")}</th>
                <th className="py-1 pr-2">{tr("booking.print.to_pay")}</th>
                <th className="py-1 pr-2">{tr("booking.print.terms_pending")}</th>
                <th className="py-1 pr-2">{tr("booking.print.health_missing")}</th>
                <th className="py-1">{tr("booking.print.notes")}</th>
              </tr>
            </thead>
            <tbody>
              {s.attendees.map((a) => (
                <tr key={a.bookingId} className="border-b align-top">
                  <td className="py-1 pr-2 tabular-nums">{brusselsTime(s.startsAt)}</td>
                  <td className="py-1 pr-2">{a.name}</td>
                  <td className="py-1 pr-2">{a.guestOf ?? ""}</td>
                  <td className="py-1 pr-2">{tr(`booking.paidWith.${a.paidWith}`)}</td>
                  <td className="py-1 pr-2 tabular-nums">{a.toPayCents !== null ? formatMoney(a.toPayCents, locale) : ""}</td>
                  <td className="py-1 pr-2">{a.termsPending ? yes : ""}</td>
                  <td className="py-1 pr-2">{a.healthMissing ? yes : ""}</td>
                  <td className="py-1">{a.notes ?? ""}</td>
                </tr>
              ))}
              {s.attendees.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-2 text-muted-foreground">
                    {tr("booking.session.empty")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
