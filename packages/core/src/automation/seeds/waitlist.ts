/**
 * Waitlist journeys (spec 3.6): `waitlist-offer` (V1, transactional; the expiry reminder 30
 * minutes before the offer ends, while booking sends the claim email with the single-use token
 * in the offer transaction) and `waitlist-follow-up` (R2 draft; "other dates" after an expired
 * offer, in the exclusive `waitlist` group).
 */
import { c, definition, fromAnchor, fromEnrolment, HOUR, seedTemplate, type SeedAutomation } from "./groups";

const EXPIRING = seedTemplate({
  slug: "automation.waitlist_offer_expiring",
  name: "Automation: waitlist offer expiring",
  kind: "transactional",
  path: "/account/waitlist",
  copy: {
    "nl-BE": c("Je plaats verloopt over 30 minuten", "Bevestig snel je vrijgekomen plaats.", "Nog 30 minuten", "Er is een plaats voor je vrijgekomen, maar het aanbod verloopt over 30 minuten. Bevestig het in je account.", "Bevestig je plaats"),
    "fr-BE": c("Votre place expire dans 30 minutes", "Confirmez vite la place libérée.", "Plus que 30 minutes", "Une place s'est libérée pour vous, mais l'offre expire dans 30 minutes. Confirmez-la dans votre compte.", "Confirmer votre place"),
    en: c("Your spot expires in 30 minutes", "Confirm your freed-up spot quickly.", "30 minutes left", "A spot has opened up for you, but the offer expires in 30 minutes. Confirm it in your account.", "Confirm your spot"),
  },
});

const OTHER_DATES = seedTemplate({
  slug: "waitlist-follow-up-other-dates",
  name: "Waitlist follow-up: other dates",
  kind: "marketing",
  purpose: "events",
  path: "/events",
  copy: {
    "nl-BE": c("Andere data voor jou", "Er zijn nog plaatsen vrij.", "Kies een andere datum", "Je wachtlijstplaats is verlopen, maar op deze data is er nog plaats.", "Bekijk de data"),
    "fr-BE": c("D'autres dates pour vous", "Il reste des places.", "Choisissez une autre date", "Votre place sur la liste d'attente a expiré, mais il reste de la place à ces dates.", "Voir les dates"),
    en: c("Other dates for you", "There are still spots available.", "Choose another date", "Your waitlist spot has expired, but there is still room on these dates.", "See the dates"),
  },
});

const sameSubject = (event: string) => ({ event, same_subject: true });

export const WAITLIST_SEEDS: SeedAutomation[] = [
  {
    slug: "waitlist-offer",
    name: "Waitlist offer",
    description: "Reminder 30 minutes before a waitlist offer expires (booking sends the claim email).",
    groupKey: "transactional",
    priority: 100,
    isMarketing: false,
    purpose: null,
    status: "active",
    requiresDpia: null,
    requiresFlag: null,
    release: "V1",
    definition: definition({
      trigger: { event: "waitlist.offered" },
      anchor: "data.offer_expires_at",
      subject: "ref",
      re_entry: "always",
      exit_on: [sameSubject("waitlist.confirmed"), sameSubject("waitlist.expired"), sameSubject("waitlist.released"), sameSubject("waitlist.withdrawn")],
      steps: [{ key: "expiring", type: "email", template: "automation.waitlist_offer_expiring", at: fromAnchor(-30) }],
    }),
    templates: [EXPIRING],
  },
  {
    slug: "waitlist-follow-up",
    name: "Waitlist follow-up",
    description: "Other dates one hour after a waitlist offer expired (Release 2).",
    groupKey: "waitlist",
    priority: 100,
    isMarketing: true,
    purpose: "events",
    status: "draft",
    requiresDpia: null,
    requiresFlag: null,
    release: "R2",
    definition: definition({
      trigger: { event: "waitlist.expired" },
      anchor: "enrolment",
      re_entry: "after_days:7",
      exit_on: ["booking.confirmed"],
      steps: [{ key: "other_dates", type: "email", template: "waitlist-follow-up-other-dates", at: fromEnrolment(HOUR), unless: { has_future_booking: true } }],
    }),
    templates: [OTHER_DATES],
  },
];
