/**
 * booking's transactional templates (booking spec R59). Registry keys and `email_templates.slug`
 * values `booking.<name>`, where `<name>` is the file basename with `-` replaced by `_`.
 * booking-P3a: `booking.booking_confirmed`, `booking.guest_invited`; booking-P3b:
 * `booking.booking_rescheduled`, `booking.booking_cancelled`, `booking.booking_late_cancelled`,
 * `booking.session_cancelled`, `booking.booking_reminder`; booking-P5: `booking.waitlist_joined`, `booking.seat_offered`, `booking.seat_claimed`,
 * `booking.offer_expired`. The check-in QR is an inline attachment (`cid:checkin-qr.png`) passed by the
 * sender, so no template builds attachments itself.
 */
import { defineTemplate } from "../define";
import { BookingConfirmed, BookingConfirmedProps } from "./booking-confirmed";
import { BookingCancelled, BookingCancelledProps } from "./booking-cancelled";
import { BookingLateCancelled, BookingLateCancelledProps } from "./booking-late-cancelled";
import { BookingReminder, BookingReminderProps } from "./booking-reminder";
import { BookingRescheduled, BookingRescheduledProps } from "./booking-rescheduled";
import { GuestInvited, GuestInvitedProps } from "./guest-invited";
import { OfferExpired, OfferExpiredProps } from "./offer-expired";
import { SeatClaimed, SeatClaimedProps } from "./seat-claimed";
import { SeatOffered, SeatOfferedProps } from "./seat-offered";
import { SessionCancelled, SessionCancelledProps } from "./session-cancelled";
import { WaitlistJoined, WaitlistJoinedProps } from "./waitlist-joined";

export const templates = [
  defineTemplate({
    name: "booking_confirmed",
    component: BookingConfirmed,
    props: BookingConfirmedProps,
    sample: {
      title: "Yin yoga",
      date: "do 12 nov. 2026, 18:30",
      url: "https://beam.example.com/nl/account/bookings/bk_sample",
      payAtDesk: true,
    },
    slots: {
      subject: "booking.email.booking_confirmed.subject",
      heading: "booking.email.booking_confirmed.heading",
      intro: "booking.email.booking_confirmed.intro",
      pay_at_desk: "booking.email.booking_confirmed.pay_at_desk",
      qr: "booking.email.booking_confirmed.qr",
      cta: "booking.email.booking_confirmed.cta",
    },
  }),
  defineTemplate({
    name: "guest_invited",
    component: GuestInvited,
    props: GuestInvitedProps,
    sample: {
      title: "Yin yoga",
      date: "do 12 nov. 2026, 18:30",
      url: "https://beam.example.com/nl/account/bookings/bk_sample/guest",
      ownerFirstName: "An",
    },
    slots: {
      subject: "booking.email.guest_invited.subject",
      heading: "booking.email.guest_invited.heading",
      intro: "booking.email.guest_invited.intro",
      qr: "booking.email.guest_invited.qr",
      cta: "booking.email.guest_invited.cta",
    },
  }),
  defineTemplate({
    name: "booking_rescheduled",
    component: BookingRescheduled,
    props: BookingRescheduledProps,
    sample: {
      title: "Yin yoga",
      date: "za 14 nov. 2026, 10:00",
      oldDate: "do 12 nov. 2026, 18:30",
      url: "https://beam.example.com/nl/account/bookings/bk_sample",
    },
    slots: {
      subject: "booking.email.booking_rescheduled.subject",
      heading: "booking.email.booking_rescheduled.heading",
      intro: "booking.email.booking_rescheduled.intro",
      qr: "booking.email.booking_rescheduled.qr",
      cta: "booking.email.booking_rescheduled.cta",
    },
  }),
  defineTemplate({
    name: "booking_cancelled",
    component: BookingCancelled,
    props: BookingCancelledProps,
    sample: { title: "Yin yoga", date: "do 12 nov. 2026, 18:30", url: "https://beam.example.com/nl/account/book", reason: "cancelled" },
    slots: {
      subject: "booking.email.booking_cancelled.subject",
      heading: "booking.email.booking_cancelled.heading",
      intro: "booking.email.booking_cancelled.intro",
      payment_expired: "booking.email.booking_cancelled.payment_expired",
      cta: "booking.email.booking_cancelled.cta",
    },
  }),
  defineTemplate({
    name: "booking_late_cancelled",
    component: BookingLateCancelled,
    props: BookingLateCancelledProps,
    sample: { title: "Yin yoga", date: "do 12 nov. 2026, 18:30", url: "https://beam.example.com/nl/account/book" },
    slots: {
      subject: "booking.email.booking_late_cancelled.subject",
      heading: "booking.email.booking_late_cancelled.heading",
      intro: "booking.email.booking_late_cancelled.intro",
      cta: "booking.email.booking_late_cancelled.cta",
    },
  }),
  defineTemplate({
    name: "session_cancelled",
    component: SessionCancelled,
    props: SessionCancelledProps,
    sample: { title: "Yin yoga", date: "do 12 nov. 2026, 18:30", url: "https://beam.example.com/nl/account/book", refunded: true, creditReleased: false },
    slots: {
      subject: "booking.email.session_cancelled.subject",
      heading: "booking.email.session_cancelled.heading",
      intro: "booking.email.session_cancelled.intro",
      refunded: "booking.email.session_cancelled.refunded",
      credit_released: "booking.email.session_cancelled.credit_released",
      cta: "booking.email.session_cancelled.cta",
    },
  }),
  defineTemplate({
    name: "booking_reminder",
    component: BookingReminder,
    props: BookingReminderProps,
    sample: { title: "Yin yoga", date: "do 12 nov. 2026, 18:30", url: "https://beam.example.com/nl/account/bookings/bk_sample", kind: "day" },
    slots: {
      subject: "booking.email.booking_reminder.subject",
      heading: "booking.email.booking_reminder.heading",
      intro_day: "booking.email.booking_reminder.intro_day",
      intro_night: "booking.email.booking_reminder.intro_night",
      qr: "booking.email.booking_reminder.qr",
      cta: "booking.email.booking_reminder.cta",
    },
  }),
  defineTemplate({
    name: "waitlist_joined",
    component: WaitlistJoined,
    props: WaitlistJoinedProps,
    sample: { title: "Yin yoga", date: "do 12 nov. 2026, 18:30", url: "https://beam.example.com/nl/account/waitlist" },
    slots: {
      subject: "booking.email.waitlist_joined.subject",
      heading: "booking.email.waitlist_joined.heading",
      intro: "booking.email.waitlist_joined.intro",
      cta: "booking.email.waitlist_joined.cta",
    },
  }),
  defineTemplate({
    name: "seat_offered",
    component: SeatOffered,
    props: SeatOfferedProps,
    sample: {
      title: "Yin yoga",
      date: "do 12 nov. 2026, 18:30",
      expiresAt: "do 12 nov. 2026, 12:30",
      url: "https://beam.example.com/api/public/claim/sample-claim-token-0000000000000000000000",
    },
    slots: {
      subject: "booking.email.seat_offered.subject",
      heading: "booking.email.seat_offered.heading",
      intro: "booking.email.seat_offered.intro",
      cta: "booking.email.seat_offered.cta",
    },
  }),
  defineTemplate({
    name: "seat_claimed",
    component: SeatClaimed,
    props: SeatClaimedProps,
    sample: { title: "Yin yoga", date: "do 12 nov. 2026, 18:30", url: "https://beam.example.com/nl/account/bookings/bk_sample" },
    slots: {
      subject: "booking.email.seat_claimed.subject",
      heading: "booking.email.seat_claimed.heading",
      intro: "booking.email.seat_claimed.intro",
      qr: "booking.email.seat_claimed.qr",
      cta: "booking.email.seat_claimed.cta",
    },
  }),
  defineTemplate({
    name: "offer_expired",
    component: OfferExpired,
    props: OfferExpiredProps,
    sample: { title: "Yin yoga", date: "do 12 nov. 2026, 18:30", url: "https://beam.example.com/nl/account/book/session_sample" },
    slots: {
      subject: "booking.email.offer_expired.subject",
      heading: "booking.email.offer_expired.heading",
      intro: "booking.email.offer_expired.intro",
      cta: "booking.email.offer_expired.cta",
    },
  }),
];
