/**
 * The assistant's starter journeys (docs/plan/modules/assistant.md phase 6), written by the
 * assistant seed with automation's own writer (a slug is inserted only when absent, so staff edits
 * are never overwritten):
 * - `assistant-hot-lead-call` (sales tasks, active): a qualified lead from the chat gets a call
 *   task the same day, unless they booked or bought in the meantime.
 * - `assistant-lead-follow-up` (marketing, draft until BEAM reviews the copy): a chat lead who
 *   ticked the newsletter box gets a personal follow-up the next morning; who raised the price
 *   gets the package explanation three days later, the others the day-or-night explanation. Every
 *   email passes the consent and suppression checks of the automation engine (A-31).
 */
import type { Condition } from "@beam/core/automation";
import { c, DAY, definition, fromEnrolment, seedTemplate, type SeedAutomation } from "@beam/core/automation/seeds";

const m = (slug: string, name: string, path: string, copy: Parameters<typeof seedTemplate>[0]["copy"]) => seedTemplate({ slug, name, kind: "marketing", purpose: "newsletter", path, copy });

const TEMPLATES = [
  m("assistant-follow-up-1", "Assistant lead: personal follow-up", "/book", {
    "nl-BE": c("Je vraag aan BEAM", "We helpen je graag verder.", "Fijn dat je ons vond", "Je stelde ons gisteren een vraag via de chat. Wil je meteen een moment kiezen? Hieronder zie je wanneer er plaats is. Liever eerst iemand spreken? Antwoord gewoon op deze mail.", "Bekijk beschikbaarheid"),
    "fr-BE": c("Votre question à BEAM", "Nous vous aidons volontiers.", "Merci de nous avoir trouvés", "Vous nous avez posé une question hier via le chat. Envie de choisir un moment ? Voici les disponibilités. Vous préférez parler à quelqu'un ? Répondez simplement à cet e-mail.", "Voir les disponibilités"),
    en: c("Your question to BEAM", "We're happy to help.", "Glad you found us", "You asked us a question in the chat yesterday. Want to pick a moment straight away? Here is when there's room. Rather talk to someone first? Just reply to this email.", "See availability"),
  }),
  m("assistant-follow-up-packages", "Assistant lead: packages", "/book", {
    "nl-BE": c("Voordeliger met een pakket", "Te delen met tot vijf personen.", "Meer BEAM voor minder", "Pakketten van 10 tot 100 uur zijn voordeliger dan losse sessies, 18 maanden geldig en te delen met tot vijf personen. Zo komt een sessie een pak goedkoper uit.", "Bekijk de pakketten"),
    "fr-BE": c("Plus avantageux avec un forfait", "Partageable avec jusqu'à cinq personnes.", "Plus de BEAM pour moins", "Les forfaits de 10 à 100 heures sont plus avantageux que les séances individuelles, valables 18 mois et partageables avec jusqu'à cinq personnes.", "Voir les forfaits"),
    en: c("Better value with a package", "Share it with up to five people.", "More BEAM for less", "Packages of 10 to 100 hours cost less than single sessions, are valid for 18 months and can be shared with up to five people.", "See the packages"),
  }),
  m("assistant-follow-up-day-night", "Assistant lead: day or night", "/book", {
    "nl-BE": c("Dag of nacht: wat past bij jou?", "Dezelfde ruimte, een andere ervaring.", "Dag of nacht", "Overdag kies je een tijdslot en twee opeenvolgende sessies geven je het uur ertussen cadeau. 's Nachts heb je een eigen bed in een ruimte die de hele nacht rustig blijft.", "Kies je moment"),
    "fr-BE": c("Jour ou nuit : que choisir ?", "La même salle, une autre expérience.", "Jour ou nuit", "En journée, vous choisissez un créneau et deux séances consécutives vous offrent l'heure entre les deux. La nuit, vous avez votre propre lit dans une salle calme toute la nuit.", "Choisir votre moment"),
    en: c("Day or night: which suits you?", "The same room, a different experience.", "Day or night", "By day you pick a time slot, and two consecutive sessions give you the hour in between for free. At night you have your own bed in a room that stays calm all night.", "Pick your moment"),
  }),
];

const booked: Condition = { any: [{ has_future_booking: true }, { status_in: ["customer", "member"] }] };

export const ASSISTANT_AUTOMATIONS: SeedAutomation[] = [
  {
    slug: "assistant-hot-lead-call",
    name: "Assistant: call a hot chat lead",
    description: "A call task the same day for a lead the assistant qualified, unless they booked or bought.",
    groupKey: "sales",
    priority: 90,
    isMarketing: false,
    purpose: null,
    status: "active",
    requiresDpia: null,
    requiresFlag: null,
    release: "R3",
    definition: definition({
      trigger: { event: "assistant.lead_qualified" },
      anchor: "enrolment",
      audience: {},
      re_entry: "never",
      exit_on: ["order.paid", "booking.confirmed"],
      steps: [{ key: "call", type: "task", title: "Bel hete lead uit de chat (zie gesprek bij de klant)", kind: "call", owner_role: "sales", due_in_minutes: 240, priority: "high", at: fromEnrolment(0), unless: booked }],
    }),
    templates: [],
  },
  {
    slug: "assistant-lead-follow-up",
    name: "Assistant: follow up a chat lead",
    description: "A personal follow-up the morning after a chat, then packages (price objection) or day-or-night (everyone else).",
    groupKey: "lead_nurture",
    priority: 90,
    isMarketing: true,
    purpose: "newsletter",
    status: "draft",
    requiresDpia: null,
    requiresFlag: null,
    release: "R3",
    definition: definition({
      trigger: { event: "assistant.lead_captured", where: { "data.newsletter": { eq: true } } },
      anchor: "enrolment",
      audience: { status: ["lead"] },
      re_entry: "never",
      exit_on: ["order.paid", "booking.confirmed"],
      steps: [
        { key: "follow_up", type: "email", template: "assistant-follow-up-1", at: fromEnrolment(DAY, "10:00") },
        { key: "price", type: "condition", if: { has_tag: "objection:price" }, then: "packages", else: "day_night" },
        { key: "packages", type: "email", template: "assistant-follow-up-packages", at: fromEnrolment(4 * DAY, "10:00") },
        { key: "end_packages", type: "exit" },
        { key: "day_night", type: "email", template: "assistant-follow-up-day-night", at: fromEnrolment(4 * DAY, "10:00") },
      ],
    }),
    templates: TEMPLATES,
  },
];
