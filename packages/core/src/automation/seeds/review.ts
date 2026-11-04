/**
 * `review-request` (spec 3.6): one review request after an attended visit, at most once per 30
 * days per person (`after_days:30` is judged across subjects, A-13). Never after a no-show: the
 * trigger is `booking.attended` only, the `unless` re-checks the booking at send time (A-27) and a
 * `booking.no_show` of the same booking exits the journey.
 */
import { c, DAY, definition, fromEnrolment, seedTemplate, type SeedAutomation } from "./groups";

const ASK = seedTemplate({
  slug: "review-request-ask",
  name: "Review request: ask",
  kind: "marketing",
  purpose: "newsletter",
  path: "/reviews",
  copy: {
    "nl-BE": c("Hoe was je bezoek aan BEAM?", "Je review helpt anderen kiezen.", "Deel je ervaring", "Vond je je bezoek fijn? Met een korte review help je anderen BEAM te ontdekken.", "Schrijf een review"),
    "fr-BE": c("Comment s'est passée votre visite chez BEAM ?", "Votre avis aide d'autres personnes à choisir.", "Partagez votre expérience", "Vous avez apprécié votre visite ? Un court avis aide d'autres personnes à découvrir BEAM.", "Écrire un avis"),
    en: c("How was your visit to BEAM?", "Your review helps others choose.", "Share your experience", "Did you enjoy your visit? A short review helps others discover BEAM.", "Write a review"),
  },
});

export const REVIEW_SEEDS: SeedAutomation[] = [
  {
    slug: "review-request",
    name: "Review request",
    description: "One review request the day after an attended visit, at most once per 30 days.",
    groupKey: "review",
    priority: 100,
    isMarketing: true,
    purpose: "newsletter",
    status: "active",
    requiresDpia: null,
    requiresFlag: null,
    release: "V1",
    definition: definition({
      trigger: { event: "booking.attended" },
      anchor: "enrolment",
      subject: "ref",
      re_entry: "after_days:30",
      exit_on: [{ event: "booking.no_show", same_subject: true }],
      steps: [
        {
          key: "ask",
          type: "email",
          template: "review-request-ask",
          at: fromEnrolment(DAY, "11:00"),
          unless: { any: [{ booking_status_in: ["no_show", "cancelled"] }, { has_tag: "reviewed" }] },
        },
      ],
    }),
    templates: [ASK],
  },
];
