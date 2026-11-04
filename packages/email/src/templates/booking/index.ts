/**
 * booking's transactional templates (booking spec R59). Registry keys and `email_templates.slug`
 * values `booking.<name>`, where `<name>` is the file basename with `-` replaced by `_`.
 * booking-P3a: `booking.booking_confirmed`, `booking.guest_invited`; booking-P3b adds the
 * rescheduled, cancelled, late-cancelled, session-cancelled and reminder templates; booking-P5
 * the waitlist ones. The check-in QR is an inline attachment (`cid:checkin-qr.png`) passed by the
 * sender, so no template builds attachments itself.
 */
import { defineTemplate } from "../define";
import { BookingConfirmed, BookingConfirmedProps } from "./booking-confirmed";
import { GuestInvited, GuestInvitedProps } from "./guest-invited";

export const templates = [
  defineTemplate({
    name: "booking_confirmed",
    component: BookingConfirmed,
    props: BookingConfirmedProps,
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
    slots: {
      subject: "booking.email.guest_invited.subject",
      heading: "booking.email.guest_invited.heading",
      intro: "booking.email.guest_invited.intro",
      qr: "booking.email.guest_invited.qr",
      cta: "booking.email.guest_invited.cta",
    },
  }),
];
