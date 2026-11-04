/** Lead journeys (spec 3.6): `welcome-lead` (marketing nurture) and `lead-sales-follow-up` (tasks). */
import type { Condition, Filter } from "../definition";
import { c, DAY, definition, fromEnrolment, seedTemplate, type SeedAutomation } from "./groups";

/** `person.created` of a real lead: not imported, not typed in by staff, not a walk-in or B2B contact. */
export const NEW_LEAD_FILTER: Filter = { "data.acquisition_source": { nin: ["import", "manual", "walk_in", "b2b_campaign"] } };

const m = (slug: string, name: string, path: string, copy: Parameters<typeof seedTemplate>[0]["copy"]) =>
  seedTemplate({ slug, name, kind: "marketing", purpose: "newsletter", path, copy });

const WELCOME_TEMPLATES = [
  m("welcome-lead-welcome", "Welcome lead: welcome", "/", {
    "nl-BE": c("Welkom bij BEAM", "Fijn dat je er bent.", "Welkom bij BEAM", "Bedankt voor je interesse. In de komende weken vertellen we je meer over wat BEAM voor jou kan doen.", "Ontdek BEAM"),
    "fr-BE": c("Bienvenue chez BEAM", "Ravis de vous compter parmi nous.", "Bienvenue chez BEAM", "Merci pour votre intérêt. Dans les semaines à venir, nous vous en dirons plus sur ce que BEAM peut faire pour vous.", "Découvrir BEAM"),
    en: c("Welcome to BEAM", "Glad to have you here.", "Welcome to BEAM", "Thank you for your interest. Over the coming weeks we will tell you more about what BEAM can do for you.", "Discover BEAM"),
  }),
  m("welcome-lead-edu-1", "Welcome lead: education 1", "/", {
    "nl-BE": c("Waarom rust zo belangrijk is", "Een eerste inzicht van BEAM.", "Waarom rust zo belangrijk is", "Herstel begint bij echte rust. We leggen je uit hoe BEAM daarbij helpt.", "Lees meer"),
    "fr-BE": c("Pourquoi le repos est si important", "Un premier éclairage de BEAM.", "Pourquoi le repos est si important", "La récupération commence par un vrai repos. Nous vous expliquons comment BEAM vous y aide.", "En savoir plus"),
    en: c("Why rest matters so much", "A first insight from BEAM.", "Why rest matters so much", "Recovery starts with real rest. We explain how BEAM helps you with it.", "Read more"),
  }),
  m("welcome-lead-edu-2", "Welcome lead: education 2", "/", {
    "nl-BE": c("Zo verloopt een bezoek aan BEAM", "Wat je kunt verwachten.", "Zo verloopt een bezoek", "Van ontvangst tot afsluiting: zo ziet een dag of nacht bij BEAM eruit.", "Bekijk het aanbod"),
    "fr-BE": c("Comment se déroule une visite chez BEAM", "Ce qui vous attend.", "Comment se déroule une visite", "De l'accueil à la fin : voici à quoi ressemble une journée ou une nuit chez BEAM.", "Voir l'offre"),
    en: c("What a visit to BEAM looks like", "What to expect.", "What a visit looks like", "From welcome to goodbye: this is what a day or night at BEAM looks like.", "See the offer"),
  }),
  m("welcome-lead-webinar-invite", "Welcome lead: webinar invitation", "/webinars", {
    "nl-BE": c("Volg ons gratis webinar", "Leer BEAM kennen vanuit je zetel.", "Gratis webinar", "In ons webinar vertellen we hoe BEAM werkt en beantwoorden we je vragen live.", "Schrijf je in"),
    "fr-BE": c("Suivez notre webinaire gratuit", "Découvrez BEAM depuis votre canapé.", "Webinaire gratuit", "Dans notre webinaire, nous expliquons comment fonctionne BEAM et répondons à vos questions en direct.", "S'inscrire"),
    en: c("Join our free webinar", "Get to know BEAM from your sofa.", "Free webinar", "In our webinar we explain how BEAM works and answer your questions live.", "Sign up"),
  }),
  m("welcome-lead-experience-invite", "Welcome lead: BEAM Experience invitation", "/events", {
    "nl-BE": c("Je bent uitgenodigd: BEAM Experience", "Beleef BEAM zelf.", "Kom naar een BEAM Experience", "Ervaar BEAM tijdens een kennismakingsevent, samen met ons team.", "Bekijk de data"),
    "fr-BE": c("Vous êtes invité·e : BEAM Experience", "Vivez BEAM par vous-même.", "Venez à une BEAM Experience", "Découvrez BEAM lors d'un événement de découverte, avec notre équipe.", "Voir les dates"),
    en: c("You are invited: BEAM Experience", "Experience BEAM yourself.", "Come to a BEAM Experience", "Experience BEAM at an introduction event, together with our team.", "See the dates"),
  }),
  m("welcome-lead-edu-3", "Welcome lead: education 3", "/", {
    "nl-BE": c("Wat anderen over BEAM zeggen", "Ervaringen van bezoekers.", "Ervaringen van bezoekers", "Lees hoe anderen hun eerste bezoek aan BEAM beleefden.", "Lees de ervaringen"),
    "fr-BE": c("Ce que d'autres disent de BEAM", "Témoignages de visiteurs.", "Témoignages de visiteurs", "Découvrez comment d'autres ont vécu leur première visite chez BEAM.", "Lire les témoignages"),
    en: c("What others say about BEAM", "Stories from visitors.", "Stories from visitors", "Read how others experienced their first visit to BEAM.", "Read the stories"),
  }),
];

const salesUnless: Condition = { any: [{ has_future_booking: true }, { status_in: ["customer", "member"] }] };

export const LEAD_SEEDS: SeedAutomation[] = [
  {
    slug: "welcome-lead",
    name: "Welcome lead",
    description: "Welcome and education emails for a new lead, with BEAM Experience and webinar invitations.",
    groupKey: "lead_nurture",
    priority: 100,
    isMarketing: true,
    purpose: "newsletter",
    status: "active",
    requiresDpia: null,
    requiresFlag: null,
    release: "V1",
    definition: definition({
      trigger: { event: "person.created", where: NEW_LEAD_FILTER },
      anchor: "enrolment",
      audience: { status: ["lead"] },
      re_entry: "never",
      exit_on: ["order.paid", "booking.attended", "membership.started"],
      steps: [
        { key: "welcome", type: "email", template: "welcome-lead-welcome", at: fromEnrolment(0) },
        { key: "edu_1", type: "email", template: "welcome-lead-edu-1", at: fromEnrolment(2 * DAY, "10:00") },
        { key: "edu_2", type: "email", template: "welcome-lead-edu-2", at: fromEnrolment(5 * DAY, "10:00") },
        { key: "webinar_invite", type: "email", template: "welcome-lead-webinar-invite", at: fromEnrolment(7 * DAY, "10:00") },
        { key: "engaged", type: "condition", if: { event_since_enrolment: "email.clicked" }, then: "tag_engaged", else: "experience_invite" },
        { key: "tag_engaged", type: "tag", tag: "engaged" },
        { key: "experience_invite", type: "email", template: "welcome-lead-experience-invite", at: fromEnrolment(10 * DAY, "10:00") },
        { key: "edu_3", type: "email", template: "welcome-lead-edu-3", at: fromEnrolment(14 * DAY, "10:00") },
      ],
    }),
    templates: WELCOME_TEMPLATES,
  },
  {
    slug: "lead-sales-follow-up",
    name: "Lead sales follow-up",
    description: "Two call tasks for the sales team after a new lead, unless the lead booked or bought.",
    groupKey: "sales",
    priority: 100,
    isMarketing: false,
    purpose: null,
    status: "active",
    requiresDpia: null,
    requiresFlag: null,
    release: "V1",
    definition: definition({
      trigger: { event: "person.created", where: NEW_LEAD_FILTER },
      anchor: "enrolment",
      audience: { status: ["lead"] },
      re_entry: "never",
      exit_on: ["order.paid", "booking.confirmed"],
      steps: [
        { key: "call_1", type: "task", title: "Bel nieuwe lead: BEAM Experience voorstellen", kind: "call", owner_role: "sales", due_in_minutes: DAY, priority: "normal", at: fromEnrolment(2 * DAY), unless: salesUnless },
        { key: "call_2", type: "task", title: "Bel nieuwe lead: BEAM Experience voorstellen", kind: "call", owner_role: "sales", due_in_minutes: DAY, priority: "normal", at: fromEnrolment(9 * DAY), unless: salesUnless },
      ],
    }),
    templates: [],
  },
];
