/**
 * Event journeys (spec 3.6, decision 15): `event-registration` (V1; reminders 7 days, 3 days and
 * 3 hours before an event session, scenario 1) and `event-follow-up` (R2 draft, on
 * `booking.event_ended`). No confirmation step: booking sends `booking.booking_confirmed`.
 */
import { c, DAY, definition, fromAnchor, fromEnrolment, HOUR, seedTemplate, type SeedAutomation } from "./groups";

const t = (slug: string, name: string, path: string, copy: Parameters<typeof seedTemplate>[0]["copy"]) => seedTemplate({ slug, name, kind: "transactional", path, copy });

const REMINDERS = [
  t("automation.event_reminder_7d", "Automation: event reminder 7 days", "/account/bookings", {
    "nl-BE": c("Nog een week tot je event", "We kijken ernaar uit.", "Nog een week", "Over een week verwelkomen we je op het event. Je vindt alle praktische info in je account.", "Bekijk je boeking"),
    "fr-BE": c("Plus qu'une semaine avant votre événement", "Nous avons hâte.", "Plus qu'une semaine", "Dans une semaine, nous vous accueillons à l'événement. Toutes les infos pratiques sont dans votre compte.", "Voir votre réservation"),
    en: c("One week to go until your event", "We are looking forward to it.", "One week to go", "In one week we welcome you to the event. You find all practical details in your account.", "View your booking"),
  }),
  t("automation.event_reminder_3d", "Automation: event reminder 3 days", "/account/bookings", {
    "nl-BE": c("Over drie dagen is het zover", "Praktische info voor je event.", "Nog drie dagen", "Over drie dagen is het event. Kom op tijd en breng je QR-code mee.", "Bekijk je boeking"),
    "fr-BE": c("Dans trois jours, c'est le grand jour", "Infos pratiques pour votre événement.", "Plus que trois jours", "L'événement a lieu dans trois jours. Arrivez à l'heure et apportez votre code QR.", "Voir votre réservation"),
    en: c("Three days to go", "Practical details for your event.", "Three days to go", "The event is in three days. Arrive on time and bring your QR code.", "View your booking"),
  }),
  t("automation.event_reminder_day_of", "Automation: event reminder day of", "/account/bookings", {
    "nl-BE": c("Vandaag is het event", "Tot straks bij BEAM.", "Tot straks", "Het event begint binnen enkele uren. We zien je graag bij BEAM.", "Bekijk je boeking"),
    "fr-BE": c("L'événement, c'est aujourd'hui", "À tout à l'heure chez BEAM.", "À tout à l'heure", "L'événement commence dans quelques heures. Au plaisir de vous voir chez BEAM.", "Voir votre réservation"),
    en: c("The event is today", "See you soon at BEAM.", "See you soon", "The event starts in a few hours. We look forward to seeing you at BEAM.", "View your booking"),
  }),
];

const FOLLOW_UP = [
  t("automation.event_follow_up_thanks", "Automation: event follow-up thanks", "/events", {
    "nl-BE": c("Bedankt voor je komst", "Fijn dat je erbij was.", "Bedankt", "Bedankt dat je op het event was. We hopen dat je ervan genoten hebt.", "Bekijk andere events"),
    "fr-BE": c("Merci de votre venue", "Ravis que vous ayez été là.", "Merci", "Merci d'avoir participé à l'événement. Nous espérons que vous l'avez apprécié.", "Voir d'autres événements"),
    en: c("Thank you for coming", "Glad you were there.", "Thank you", "Thank you for coming to the event. We hope you enjoyed it.", "See other events"),
  }),
  t("automation.event_follow_up_feedback", "Automation: event follow-up feedback", "/f/contact", {
    "nl-BE": c("Hoe vond je het event?", "Je mening helpt ons.", "Je mening telt", "Laat ons in twee minuten weten wat je van het event vond.", "Geef je mening"),
    "fr-BE": c("Comment avez-vous trouvé l'événement ?", "Votre avis nous aide.", "Votre avis compte", "Dites-nous en deux minutes ce que vous avez pensé de l'événement.", "Donner votre avis"),
    en: c("How did you like the event?", "Your opinion helps us.", "Your opinion counts", "Tell us in two minutes what you thought of the event.", "Give your opinion"),
  }),
  seedTemplate({
    slug: "event-follow-up-offer",
    name: "Event follow-up: offer",
    kind: "marketing",
    purpose: "events",
    path: "/events",
    copy: {
      "nl-BE": c("Een volgend event voor jou", "Speciaal voor deelnemers.", "Tot op het volgende event", "Als deelnemer ben je als eerste welkom op ons volgende event.", "Bekijk de events"),
      "fr-BE": c("Un prochain événement pour vous", "Spécialement pour les participants.", "Au prochain événement", "En tant que participant·e, vous êtes le premier invité à notre prochain événement.", "Voir les événements"),
      en: c("A next event for you", "Especially for participants.", "See you at the next event", "As a participant you are the first to be welcome at our next event.", "See the events"),
    },
  }),
];

export const EVENT_SEEDS: SeedAutomation[] = [
  {
    slug: "event-registration",
    name: "Event registration",
    description: "Reminders 7 days, 3 days and 3 hours before an event session (booking sends the confirmation).",
    groupKey: "transactional",
    priority: 100,
    isMarketing: false,
    purpose: null,
    status: "active",
    requiresDpia: null,
    requiresFlag: null,
    release: "V1",
    definition: definition({
      trigger: { event: "booking.confirmed", where: { "data.session_kind": "event" } },
      anchor: "data.starts_at",
      subject: "ref",
      re_entry: "always",
      exit_on: [
        { event: "booking.cancelled", same_subject: true },
        { event: "booking.late_cancelled", same_subject: true },
      ],
      steps: [
        { key: "reminder_7d", type: "email", template: "automation.event_reminder_7d", at: fromAnchor(-7 * DAY) },
        { key: "reminder_3d", type: "email", template: "automation.event_reminder_3d", at: fromAnchor(-3 * DAY) },
        { key: "reminder_day_of", type: "email", template: "automation.event_reminder_day_of", at: fromAnchor(-3 * HOUR) },
      ],
    }),
    templates: REMINDERS,
  },
  {
    slug: "event-follow-up",
    name: "Event follow-up",
    description: "Thanks, feedback request and an events offer after an attended event (Release 2).",
    groupKey: "transactional",
    priority: 100,
    isMarketing: false,
    purpose: null,
    status: "draft",
    requiresDpia: null,
    requiresFlag: null,
    release: "R2",
    definition: definition({
      trigger: { event: "booking.event_ended", where: { "data.attended": true } },
      anchor: "enrolment",
      subject: "ref",
      re_entry: "always",
      exit_on: [],
      steps: [
        { key: "thanks", type: "email", template: "automation.event_follow_up_thanks", at: fromEnrolment(2 * HOUR) },
        { key: "feedback", type: "email", template: "automation.event_follow_up_feedback", at: fromEnrolment(DAY, "10:00") },
        { key: "offer", type: "email", template: "event-follow-up-offer", at: fromEnrolment(3 * DAY, "10:00"), unless: { has_future_booking: true } },
      ],
    }),
    templates: FOLLOW_UP,
  },
];
