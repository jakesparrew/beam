"use client";
/**
 * `settings.booking_rules` editor (booking spec 3.0, 5.1 `/admin/sessions/rules` tab 1), grouped
 * by cancellation, no-show, check-in, booking window, guests, reminders, waitlist and pay at
 * desk. It submits platform's `updateSetting` (passed in by the page as `save`, versioned and
 * audited `settings.update`); a stale version shows "Someone changed these rules, reload".
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { Alert, AlertDescription, Button, Checkbox, FormField, Input, Label } from "@beam/ui";
import type { BookingRules } from "@beam/core/booking";

const str = (v: FormDataEntryValue | null): string => (typeof v === "string" ? v : "");

type SaveResult = { ok: true; data: { version: number } } | { ok: false; error: { code: string; message: string; fields?: Record<string, string> } };

export type RulesFormLabels = Record<
  | "sectionCancellation" | "sectionNoShow" | "sectionCheckIn" | "sectionWindow" | "sectionGuests" | "sectionReminders" | "sectionWaitlist" | "sectionPayAtDesk"
  | "freeCancelHours" | "eventsNeverFree" | "lateCancelReleasesCredit" | "noShowAutoMark" | "noShowAfterEnd" | "noShowReleasesCredit"
  | "bookUntil" | "horizon" | "maxGuests" | "maxSharedBed" | "maxReschedules" | "reminderHours" | "offerCutoff" | "minClaim" | "maxOffers"
  | "checkinOpens" | "checkinCloses" | "revertNoShowDays" | "payAtDeskEnabled" | "requireHealth" | "requireEmergency" | "guestAbuse"
  | "day" | "night" | "event" | "save" | "saving" | "saved" | "stale" | "invalid",
  string
>;

const KINDS = ["day", "night", "event"] as const;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="grid gap-3 rounded-md border p-4">
      <legend className="px-1 text-base font-semibold">{title}</legend>
      <div className="grid gap-3 sm:grid-cols-3">{children}</div>
    </fieldset>
  );
}

function Toggle({ name, label, defaultChecked }: { name: string; label: string; defaultChecked: boolean }) {
  return (
    <Label className="flex min-h-11 items-center gap-2 sm:col-span-3">
      <Checkbox name={name} defaultChecked={defaultChecked} />
      {label}
    </Label>
  );
}

const numberList = (s: string) =>
  s
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map(Number);

export function RulesForm({ value, version, save, labels }: { value: BookingRules; version: number; save: (input: unknown) => Promise<SaveResult>; labels: RulesFormLabels }) {
  const router = useRouter();
  const [current, setCurrent] = useState(version);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const n = (k: string) => Number(f.get(k));
    const on = (k: string) => f.get(k) === "on";
    const next: BookingRules = {
      ...value,
      free_cancel_hours: { day: n("fc_day"), night: n("fc_night"), event: on("fc_event_never") ? null : n("fc_event") },
      late_cancel_releases_credit: on("late_cancel_releases_credit"),
      no_show: { auto_mark: on("ns_auto"), after_end_minutes: n("ns_after"), releases_credit: on("ns_release") },
      book_until_minutes_before_start: { day: n("bu_day"), night: n("bu_night"), event: n("bu_event") },
      booking_horizon_days: n("horizon"),
      max_guests_per_booking: n("max_guests"),
      max_shared_bed_guests_per_booking: n("max_shared_bed"),
      max_reschedules_per_booking: n("max_reschedules"),
      reminder_hours_before: { day: numberList(str(f.get("rh_day"))), night: numberList(str(f.get("rh_night"))), event: numberList(str(f.get("rh_event"))) },
      waitlist: { offer_cutoff_minutes_before_start: n("wl_cutoff"), min_claim_minutes: n("wl_min"), max_offers_per_person_per_session: n("wl_max") },
      check_in: { opens_minutes_before_start: n("ci_opens"), closes_minutes_after_end: n("ci_closes"), revert_no_show_days: n("ci_revert") },
      pay_at_desk: { enabled: on("pad_enabled"), kinds: KINDS.filter((k) => on(`pad_${k}`)) },
      require_health_declaration: on("require_health"),
      require_emergency_contact_for_nights: on("require_emergency"),
      guest_abuse: { distinct_guests_per_30_days: n("guest_abuse") },
    };
    setPending(true);
    setMessage(null);
    try {
      const res = await save({ key: "booking_rules", value: next, expectedVersion: current });
      if (res.ok) {
        setCurrent(res.data.version);
        setMessage({ error: false, text: labels.saved });
        router.refresh();
      } else setMessage({ error: true, text: res.error.code === "conflict" ? labels.stale : `${labels.invalid}${res.error.fields ? ` (${Object.keys(res.error.fields).join(", ")})` : ""}` });
    } finally {
      setPending(false);
    }
  }

  const v = value;
  const num = (name: string, label: string, val: number, min = 0) => (
    <FormField label={label}>
      <Input name={name} type="number" min={min} defaultValue={val} />
    </FormField>
  );

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4" noValidate>
      {message ? (
        <Alert variant={message.error ? "destructive" : "default"} role={message.error ? "alert" : "status"}>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}
      <Section title={labels.sectionCancellation}>
        {num("fc_day", `${labels.freeCancelHours} · ${labels.day}`, v.free_cancel_hours.day)}
        {num("fc_night", `${labels.freeCancelHours} · ${labels.night}`, v.free_cancel_hours.night)}
        {num("fc_event", `${labels.freeCancelHours} · ${labels.event}`, v.free_cancel_hours.event ?? 0)}
        <Toggle name="fc_event_never" label={labels.eventsNeverFree} defaultChecked={v.free_cancel_hours.event === null} />
        <Toggle name="late_cancel_releases_credit" label={labels.lateCancelReleasesCredit} defaultChecked={v.late_cancel_releases_credit} />
      </Section>
      <Section title={labels.sectionNoShow}>
        <Toggle name="ns_auto" label={labels.noShowAutoMark} defaultChecked={v.no_show.auto_mark} />
        {num("ns_after", labels.noShowAfterEnd, v.no_show.after_end_minutes)}
        <Toggle name="ns_release" label={labels.noShowReleasesCredit} defaultChecked={v.no_show.releases_credit} />
      </Section>
      <Section title={labels.sectionCheckIn}>
        {num("ci_opens", labels.checkinOpens, v.check_in.opens_minutes_before_start)}
        {num("ci_closes", labels.checkinCloses, v.check_in.closes_minutes_after_end)}
        {num("ci_revert", labels.revertNoShowDays, v.check_in.revert_no_show_days)}
        <Toggle name="require_health" label={labels.requireHealth} defaultChecked={v.require_health_declaration} />
      </Section>
      <Section title={labels.sectionWindow}>
        {num("bu_day", `${labels.bookUntil} · ${labels.day}`, v.book_until_minutes_before_start.day)}
        {num("bu_night", `${labels.bookUntil} · ${labels.night}`, v.book_until_minutes_before_start.night)}
        {num("bu_event", `${labels.bookUntil} · ${labels.event}`, v.book_until_minutes_before_start.event)}
        {num("horizon", labels.horizon, v.booking_horizon_days, 1)}
        {num("max_reschedules", labels.maxReschedules, v.max_reschedules_per_booking)}
      </Section>
      <Section title={labels.sectionGuests}>
        {num("max_guests", labels.maxGuests, v.max_guests_per_booking)}
        {num("max_shared_bed", labels.maxSharedBed, v.max_shared_bed_guests_per_booking)}
        {num("guest_abuse", labels.guestAbuse, v.guest_abuse.distinct_guests_per_30_days, 1)}
        <Toggle name="require_emergency" label={labels.requireEmergency} defaultChecked={v.require_emergency_contact_for_nights} />
      </Section>
      <Section title={labels.sectionReminders}>
        {KINDS.map((k) => (
          <FormField key={k} label={`${labels.reminderHours} · ${labels[k]}`}>
            <Input name={`rh_${k}`} defaultValue={v.reminder_hours_before[k].join(", ")} />
          </FormField>
        ))}
      </Section>
      <Section title={labels.sectionWaitlist}>
        {num("wl_cutoff", labels.offerCutoff, v.waitlist.offer_cutoff_minutes_before_start)}
        {num("wl_min", labels.minClaim, v.waitlist.min_claim_minutes)}
        {num("wl_max", labels.maxOffers, v.waitlist.max_offers_per_person_per_session, 1)}
      </Section>
      <Section title={labels.sectionPayAtDesk}>
        <Toggle name="pad_enabled" label={labels.payAtDeskEnabled} defaultChecked={v.pay_at_desk.enabled} />
        {KINDS.map((k) => (
          <Label key={k} className="flex min-h-11 items-center gap-2">
            <Checkbox name={`pad_${k}`} defaultChecked={v.pay_at_desk.kinds.includes(k)} />
            {labels[k]}
          </Label>
        ))}
      </Section>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? labels.saving : labels.save}
        </Button>
      </div>
    </form>
  );
}
