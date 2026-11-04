/**
 * `after-first-visit` (spec 3.6): follow-up after the first attended visit, in the exclusive
 * `customer_journey` group (priority 10, so it supersedes lead nurture in the `sales_journey`
 * lane). Transactional journey with one marketing step, whose own purpose decides reachability (A-4).
 */
import { c, DAY, definition, fromEnrolment, seedTemplate, type SeedAutomation } from "./groups";

const TEMPLATES = [
  seedTemplate({
    slug: "automation.first_visit_follow_up",
    name: "Automation: first visit follow-up",
    kind: "transactional",
    path: "/account",
    copy: {
      "nl-BE": c("Bedankt voor je eerste bezoek", "Hoe voel je je vandaag?", "Bedankt voor je bezoek", "We hopen dat je eerste bezoek aan BEAM deugd heeft gedaan. Drink vandaag voldoende water en neem rust.", "Naar je account"),
      "fr-BE": c("Merci pour votre première visite", "Comment vous sentez-vous aujourd'hui ?", "Merci pour votre visite", "Nous espérons que votre première visite chez BEAM vous a fait du bien. Buvez suffisamment d'eau et reposez-vous aujourd'hui.", "Vers votre compte"),
      en: c("Thank you for your first visit", "How do you feel today?", "Thank you for your visit", "We hope your first visit to BEAM did you good. Drink enough water and rest today.", "Go to your account"),
    },
  }),
  seedTemplate({
    slug: "automation.first_visit_feedback",
    name: "Automation: first visit feedback",
    kind: "transactional",
    path: "/f/contact",
    copy: {
      "nl-BE": c("Hoe was je eerste bezoek?", "Je feedback helpt ons beter te worden.", "Vertel het ons", "Laat ons weten hoe je je eerste bezoek hebt ervaren. Het duurt maar twee minuten.", "Geef feedback"),
      "fr-BE": c("Comment s'est passée votre première visite ?", "Vos retours nous aident à progresser.", "Dites-le-nous", "Dites-nous comment vous avez vécu votre première visite. Cela ne prend que deux minutes.", "Donner un avis"),
      en: c("How was your first visit?", "Your feedback helps us improve.", "Tell us", "Let us know how you experienced your first visit. It only takes two minutes.", "Give feedback"),
    },
  }),
  seedTemplate({
    slug: "after-first-visit-package-offer",
    name: "After first visit: package offer",
    kind: "marketing",
    purpose: "newsletter",
    path: "/shop",
    copy: {
      "nl-BE": c("Kom terug met een voordelig pakket", "Meer bezoeken, lagere prijs.", "Een pakket op jouw maat", "Wil je regelmatig komen? Met een pakket bespaar je op elk bezoek.", "Bekijk de pakketten"),
      "fr-BE": c("Revenez avec un forfait avantageux", "Plus de visites, prix plus bas.", "Un forfait à votre mesure", "Vous souhaitez venir régulièrement ? Avec un forfait, vous économisez à chaque visite.", "Voir les forfaits"),
      en: c("Come back with a package deal", "More visits, a lower price.", "A package that suits you", "Want to come regularly? With a package you save on every visit.", "See the packages"),
    },
  }),
];

export const CUSTOMER_SEEDS: SeedAutomation[] = [
  {
    slug: "after-first-visit",
    name: "After first visit",
    description: "Follow-up, feedback and a package offer after the first attended visit, with a sales task.",
    groupKey: "customer_journey",
    priority: 100,
    isMarketing: false,
    purpose: null,
    status: "active",
    requiresDpia: null,
    requiresFlag: null,
    release: "V1",
    definition: definition({
      trigger: { event: "booking.attended", where: { "data.is_first_visit": true } },
      anchor: "enrolment",
      re_entry: "never",
      exit_on: ["membership.started"],
      steps: [
        { key: "follow_up", type: "email", template: "automation.first_visit_follow_up", at: fromEnrolment(DAY, "10:00") },
        { key: "feedback", type: "email", template: "automation.first_visit_feedback", at: fromEnrolment(2 * DAY, "10:00") },
        {
          key: "package_offer",
          type: "email",
          template: "after-first-visit-package-offer",
          at: fromEnrolment(4 * DAY, "10:00"),
          unless: { any: [{ has_other_active_grant: { credit_kind: "day" } }, { has_active_membership: true }] },
        },
        { key: "sales_task", type: "task", title: "Opvolging na eerste bezoek", kind: "follow_up", owner_role: "sales", due_in_minutes: DAY, priority: "normal", at: fromEnrolment(5 * DAY), unless: { event_since_enrolment: "order.paid" } },
      ],
    }),
    templates: TEMPLATES,
  },
];
