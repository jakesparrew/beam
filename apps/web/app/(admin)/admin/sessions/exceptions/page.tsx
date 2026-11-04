import Link from "next/link";
import type { Route } from "next";
import { Badge } from "@beam/ui";
import { BOOKING_CONFLICT_REASONS, addDays, brusselsDate, brusselsTime } from "@beam/core/booking";
import { formatDate, type Locale, type LocalizedText } from "@beam/core/i18n";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listExceptions, listTemplates, listUpcomingHolidays } from "@/modules/booking/queries";
import { DeleteExceptionButton, ExceptionForm } from "@/modules/booking/ui/exception-form";
import { HolidayPanel } from "@/modules/booking/ui/holiday-panel";

const show = (text: LocalizedText | null | undefined, locale: Locale) => text?.[locale] || text?.["nl-BE"] || text?.en || text?.["fr-BE"] || "";

/**
 * `/admin/sessions/exceptions` (`settings.write`, booking spec 5.1, R4, R4b): closed days,
 * holidays and special hours of the next 12 months with the sessions that keep bookings on
 * them, the add form, and "Belgian public holidays in the next 12 months" with "Close this day".
 */
export default async function ExceptionsPage() {
  await requireStaff({ permission: "settings.write" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const today = brusselsDate(new Date());
  const [exceptions, holidays, templates] = await Promise.all([listExceptions(db, { from: today, to: addDays(today, 365) }), listUpcomingHolidays(db), listTemplates(db)]);
  const templateName = new Map(templates.map((t) => [t.id, `${show(t.name as LocalizedText, locale)} ${t.startTime.slice(0, 5)}`]));
  const localeNames = { "nl-BE": tr("platform.shell.locale_nl"), "fr-BE": tr("platform.shell.locale_fr"), en: tr("platform.shell.locale_en") };

  return (
    <div className="grid gap-8">
      <h1 className="text-2xl font-semibold">{tr("booking.exceptions.title")}</h1>
      {exceptions.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">{tr("booking.exceptions.empty")}</p>
      ) : (
        <ul className="grid gap-3">
          {exceptions.map((e) => (
            <li key={e.id} className="grid gap-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <Link href={`/admin/sessions/day/${e.onDate}` as Route} className="font-medium hover:underline">
                    {formatDate(e.onDate, locale, "full")}
                  </Link>{" "}
                  · {show(e.name as LocalizedText, locale)} <Badge variant="outline">{tr(`booking.exceptionKind.${e.kind}`)}</Badge>
                  {e.kind === "special_hours" && e.opensAt && e.closesAt ? <span className="ml-2 text-sm">{tr("booking.day.opening_hours", { opens: e.opensAt.slice(0, 5), closes: e.closesAt.slice(0, 5) })}</span> : null}
                </span>
                <DeleteExceptionButton id={e.id} label={tr("booking.common.delete")} error={tr("platform.errors.conflict")} />
              </div>
              <p className="text-sm text-muted-foreground">
                {tr("booking.exceptions.templates")}: {e.templateIds?.length ? e.templateIds.map((id) => templateName.get(id) ?? id).join(", ") : tr("booking.exceptions.all_templates")}
                {e.note ? ` · ${e.note}` : ""}
              </p>
              {e.conflicts.length ? (
                <div className="rounded border border-destructive p-2 text-sm">
                  <p className="font-medium">{tr("booking.exceptions.conflicts_title")}</p>
                  <ul className="list-disc pl-4">
                    {e.conflicts.map((c) => (
                      <li key={c.sessionId}>{tr("booking.exceptions.conflict_row", { time: brusselsTime(c.startsAt), count: c.liveBookings })}</li>
                    ))}
                  </ul>
                  <Link href={`/admin/sessions/day/${e.onDate}` as Route} className="underline">
                    {tr("booking.exceptions.cancel_conflicts")}
                  </Link>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-8 lg:grid-cols-[2fr_1fr]">
        <section aria-labelledby="add-exception" className="grid content-start gap-4">
          <h2 id="add-exception" className="text-xl font-semibold">
            {tr("booking.exceptions.add")}
          </h2>
          <ExceptionForm
            initial={{ onDate: today, kind: "closed", templateIds: [], opensAt: "", closesAt: "", name: {}, note: "" }}
            templates={templates.filter((t) => t.isActive).map((t) => ({ id: t.id, label: templateName.get(t.id)! }))}
            conflictLabels={{ one: tr("booking.exceptions.conflict_row", { time: "{time}", count: 1 }), other: tr("booking.exceptions.conflict_row", { time: "{time}", count: 999 }) }}
            labels={{
              date: tr("booking.exceptions.date"),
              kind: tr("booking.exceptions.kind"),
              kinds: { closed: tr("booking.exceptionKind.closed"), holiday: tr("booking.exceptionKind.holiday"), special_hours: tr("booking.exceptionKind.special_hours") },
              templates: tr("booking.exceptions.templates"),
              allTemplates: tr("booking.exceptions.all_templates"),
              opensAt: tr("booking.exceptions.opens_at"),
              closesAt: tr("booking.exceptions.closes_at"),
              name: { field: tr("booking.exceptions.name"), locales: localeNames, missing: tr("platform.settings.locale_missing"), complete: tr("platform.settings.locale_complete") },
              note: tr("booking.exceptions.note"),
              noteHint: tr("booking.common.no_health_notes"),
              save: tr("booking.common.save"),
              saving: tr("platform.settings.saving"),
              saved: tr("booking.common.save"),
              delete: tr("booking.common.delete"),
              conflictsTitle: tr("booking.exceptions.conflicts_title"),
              errors: {
                ...Object.fromEntries(BOOKING_CONFLICT_REASONS.map((r) => [r, tr(`booking.errors.${r}`)])),
                validation: tr("platform.errors.validation"),
                forbidden: tr("platform.errors.forbidden"),
                not_found: tr("platform.errors.not_found"),
              },
            }}
          />
        </section>
        <HolidayPanel
          items={holidays.map((h) => ({ onDate: h.onDate, dateLabel: formatDate(h.onDate, locale, "full"), label: tr(`booking.holidays.${h.key}`), name: h.name }))}
          labels={{
            title: tr("booking.exceptions.holidays_title"),
            close: tr("booking.exceptions.close_this_day"),
            empty: tr("booking.exceptions.empty"),
            error: tr("platform.errors.conflict"),
            conflicts: tr("booking.exceptions.conflicts_title"),
          }}
        />
      </div>
    </div>
  );
}
