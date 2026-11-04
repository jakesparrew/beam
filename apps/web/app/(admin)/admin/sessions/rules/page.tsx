import Link from "next/link";
import { cn } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getSettingWithVersion } from "@/lib/settings";
import { updateSetting } from "@/modules/platform/actions";
import { BusinessHoursForm } from "@/modules/booking/ui/business-hours-form";
import { RulesForm, type RulesFormLabels } from "@/modules/booking/ui/rules-form";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/**
 * `/admin/sessions/rules` (`settings.write`, booking spec 3.0, 3.0b, 5.1): tab 1
 * `settings.booking_rules`, tab 2 `settings.business_hours`. Both save through platform's
 * `updateSetting` (versioned, audited `settings.update`); booking has no settings action.
 */
export default async function RulesPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  await requireStaff({ permission: "settings.write" });
  const { tab: raw } = await searchParams;
  const tab = raw === "hours" ? "hours" : "rules";
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const common = { save: tr("booking.common.save"), saving: tr("platform.settings.saving"), saved: tr("booking.common.save"), stale: tr("booking.rules.stale"), invalid: tr("platform.errors.validation") };

  const labels: RulesFormLabels = {
    ...common,
    sectionCancellation: tr("booking.rules.section_cancellation"),
    sectionNoShow: tr("booking.rules.section_no_show"),
    sectionCheckIn: tr("booking.rules.section_check_in"),
    sectionWindow: tr("booking.rules.section_window"),
    sectionGuests: tr("booking.rules.section_guests"),
    sectionReminders: tr("booking.rules.section_reminders"),
    sectionWaitlist: tr("booking.rules.section_waitlist"),
    sectionPayAtDesk: tr("booking.rules.section_pay_at_desk"),
    freeCancelHours: tr("booking.rules.free_cancel_hours"),
    eventsNeverFree: tr("booking.rules.events_never_free"),
    lateCancelReleasesCredit: tr("booking.rules.late_cancel_releases_credit"),
    noShowAutoMark: tr("booking.rules.no_show_auto_mark"),
    noShowAfterEnd: tr("booking.rules.no_show_after_end"),
    noShowReleasesCredit: tr("booking.rules.no_show_releases_credit"),
    bookUntil: tr("booking.rules.book_until"),
    horizon: tr("booking.rules.horizon"),
    maxGuests: tr("booking.rules.max_guests"),
    maxSharedBed: tr("booking.rules.max_shared_bed"),
    maxReschedules: tr("booking.rules.max_reschedules"),
    reminderHours: tr("booking.rules.reminder_hours"),
    offerCutoff: tr("booking.rules.offer_cutoff"),
    minClaim: tr("booking.rules.min_claim"),
    maxOffers: tr("booking.rules.max_offers"),
    checkinOpens: tr("booking.rules.checkin_opens"),
    checkinCloses: tr("booking.rules.checkin_closes"),
    revertNoShowDays: tr("booking.rules.revert_no_show_days"),
    payAtDeskEnabled: tr("booking.rules.pay_at_desk_enabled"),
    requireHealth: tr("booking.rules.require_health_declaration"),
    requireEmergency: tr("booking.rules.require_emergency_contact"),
    guestAbuse: tr("booking.rules.guest_abuse_threshold"),
    day: tr("booking.kind.day"),
    night: tr("booking.kind.night"),
    event: tr("booking.kind.event"),
  };

  const tabClass = (active: boolean) => cn("-mb-px border-b-2 px-3 py-2 text-sm", active ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground");

  return (
    <div className="grid max-w-5xl gap-6">
      <h1 className="text-2xl font-semibold">{tr("booking.rules.title")}</h1>
      <nav className="flex gap-1 border-b" aria-label={tr("booking.rules.title")}>
        <Link href={{ pathname: "/admin/sessions/rules", query: { tab: "rules" } }} aria-current={tab === "rules" ? "page" : undefined} className={tabClass(tab === "rules")}>
          {tr("booking.rules.tab_rules")}
        </Link>
        <Link href={{ pathname: "/admin/sessions/rules", query: { tab: "hours" } }} aria-current={tab === "hours" ? "page" : undefined} className={tabClass(tab === "hours")}>
          {tr("booking.rules.tab_hours")}
        </Link>
      </nav>
      {tab === "rules" ? (
        <RulesForm {...(await getSettingWithVersion(db, "booking_rules"))} save={updateSetting} labels={labels} />
      ) : (
        <BusinessHoursForm
          {...(await getSettingWithVersion(db, "business_hours"))}
          save={updateSetting}
          labels={{
            ...common,
            weekdayNames: WEEKDAYS.map((d) => tr(`booking.weekday.${d}`)),
            closed: tr("booking.rules.hours_closed"),
            opensAt: tr("booking.exceptions.opens_at"),
            closesAt: tr("booking.exceptions.closes_at"),
            phone: tr("booking.rules.reception_phone"),
            note: {
              field: tr("booking.rules.note"),
              locales: { "nl-BE": tr("platform.shell.locale_nl"), "fr-BE": tr("platform.shell.locale_fr"), en: tr("platform.shell.locale_en") },
              missing: tr("platform.settings.locale_missing"),
              complete: tr("platform.settings.locale_complete"),
            },
          }}
        />
      )}
    </div>
  );
}
