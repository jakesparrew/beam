/**
 * webinar's transactional templates (webinar spec section 8). Registry keys and
 * `email_templates.slug` values `webinar.<name>`, where `<name>` is the file basename with `-`
 * replaced by `_`. webinar-P2: `webinar.rescheduled`, `webinar.cancelled`; webinar-P3 adds
 * `webinar.access`, `webinar.reminder` and `webinar.replay_available`.
 */
import { defineTemplate } from "../define";
import { Cancelled, CancelledProps } from "./cancelled";
import { Rescheduled, RescheduledProps } from "./rescheduled";

export const templates = [
  defineTemplate({
    name: "rescheduled",
    component: Rescheduled,
    props: RescheduledProps,
    sample: {
      title: "Beter slapen",
      date: "donderdag 14 januari 2027 om 19:00",
      oldDate: "dinsdag 12 januari 2027 om 19:00",
      url: "https://beam.example.com/nl/webinars/beter-slapen",
    },
    slots: {
      subject: "webinar.email.rescheduled.subject",
      heading: "webinar.email.rescheduled.heading",
      intro: "webinar.email.rescheduled.intro",
      link_valid: "webinar.email.rescheduled.link_valid",
      cta: "webinar.email.rescheduled.cta",
    },
  }),
  defineTemplate({
    name: "cancelled",
    component: Cancelled,
    props: CancelledProps,
    sample: {
      title: "Beter slapen",
      date: "dinsdag 12 januari 2027 om 19:00",
      url: "https://beam.example.com/nl/webinars/beter-slapen",
    },
    slots: {
      subject: "webinar.email.cancelled.subject",
      heading: "webinar.email.cancelled.heading",
      intro: "webinar.email.cancelled.intro",
      apology: "webinar.email.cancelled.apology",
      cta: "webinar.email.cancelled.cta",
    },
  }),
];
