/**
 * `inactivity` (spec 3.6): we-miss-you emails after 30, 60, 90 and 180 days without a visit
 * (ops emits `person.inactive_days` once per threshold and inactivity period). Nobody with a
 * future booking receives one (A-30); the 30-day email also skips members. 90 days adds a call
 * task, 180 days tags the person `dormant`.
 */
import type { Condition } from "../definition";
import { c, DAY, definition, endBranch, seedTemplate, type SeedAutomation } from "./groups";

const m = (slug: string, name: string, copy: Parameters<typeof seedTemplate>[0]["copy"]) => seedTemplate({ slug, name, kind: "marketing", purpose: "newsletter", path: "/booking", copy });

const TEMPLATES = [
  m("inactivity-30", "Inactivity: 30 days", {
    "nl-BE": c("We hebben je even niet gezien", "Tijd voor een moment voor jezelf?", "Tijd voor jezelf", "Het is een maand geleden dat je bij BEAM was. Plan je volgende bezoek wanneer het jou past.", "Plan een bezoek"),
    "fr-BE": c("Cela fait un moment", "Un moment pour vous ?", "Du temps pour vous", "Votre dernière visite chez BEAM remonte à un mois. Planifiez la prochaine quand cela vous convient.", "Planifier une visite"),
    en: c("We have not seen you for a while", "Time for a moment for yourself?", "Time for yourself", "It has been a month since you were at BEAM. Plan your next visit whenever it suits you.", "Plan a visit"),
  }),
  m("inactivity-60", "Inactivity: 60 days", {
    "nl-BE": c("We missen je bij BEAM", "Kom snel eens terug.", "We missen je", "Twee maanden zonder BEAM is lang. Kom terug en geef jezelf de rust die je verdient.", "Plan een bezoek"),
    "fr-BE": c("Vous nous manquez chez BEAM", "Revenez bientôt.", "Vous nous manquez", "Deux mois sans BEAM, c'est long. Revenez et offrez-vous le repos que vous méritez.", "Planifier une visite"),
    en: c("We miss you at BEAM", "Come back soon.", "We miss you", "Two months without BEAM is a long time. Come back and give yourself the rest you deserve.", "Plan a visit"),
  }),
  m("inactivity-90", "Inactivity: 90 days", {
    "nl-BE": c("Een nieuwe start bij BEAM?", "We helpen je graag op weg.", "Een nieuwe start", "Het is drie maanden geleden. Zullen we samen kijken welk bezoek nu bij je past?", "Plan een bezoek"),
    "fr-BE": c("Un nouveau départ chez BEAM ?", "Nous vous aidons volontiers.", "Un nouveau départ", "Cela fait trois mois. Voulez-vous que nous cherchions ensemble la visite qui vous convient ?", "Planifier une visite"),
    en: c("A fresh start at BEAM?", "We are happy to help.", "A fresh start", "It has been three months. Shall we look together at which visit suits you now?", "Plan a visit"),
  }),
  m("inactivity-180", "Inactivity: 180 days", {
    "nl-BE": c("Je plek bij BEAM blijft voor je klaar", "Welkom terug wanneer je wil.", "We houden je plek vrij", "Ook na een half jaar ben je meer dan welkom. Kom terug wanneer het voor jou het juiste moment is.", "Plan een bezoek"),
    "fr-BE": c("Votre place chez BEAM vous attend", "Bienvenue quand vous le souhaitez.", "Nous gardons votre place", "Même après six mois, vous êtes le bienvenu. Revenez quand le moment est le bon pour vous.", "Planifier une visite"),
    en: c("Your place at BEAM is waiting for you", "Welcome back whenever you like.", "We keep your place", "Even after half a year you are more than welcome. Come back when the time is right for you.", "Plan a visit"),
  }),
];

const days = (n: number): Condition => ({ trigger: { "data.days": n } });
const future: Condition = { has_future_booking: true };

export const INACTIVITY_SEEDS: SeedAutomation[] = [
  {
    slug: "inactivity",
    name: "Inactivity",
    description: "We-miss-you emails after 30, 60, 90 and 180 days without a visit.",
    groupKey: "inactivity",
    priority: 100,
    isMarketing: true,
    purpose: "newsletter",
    status: "active",
    requiresDpia: null,
    requiresFlag: null,
    release: "V1",
    definition: definition({
      trigger: { event: "person.inactive_days", where: { "data.days": { in: [30, 60, 90, 180] } } },
      anchor: "enrolment",
      audience: { status: ["customer", "member"] },
      re_entry: "always",
      exit_on: ["booking.confirmed", "order.paid"],
      steps: [
        { key: "c30", type: "condition", if: days(30), then: "d30", else: "c60" },
        { key: "d30", type: "email", template: "inactivity-30", unless: { any: [future, { has_active_membership: true }] } },
        endBranch("d30_end"),
        { key: "c60", type: "condition", if: days(60), then: "d60", else: "c90" },
        { key: "d60", type: "email", template: "inactivity-60", unless: future },
        endBranch("d60_end"),
        { key: "c90", type: "condition", if: days(90), then: "d90", else: "c180" },
        { key: "d90", type: "email", template: "inactivity-90", unless: future },
        { key: "d90_task", type: "task", title: "Klant 90 dagen niet geweest: bel", kind: "call", owner_role: "customer_service", due_in_minutes: 2 * DAY, priority: "normal", unless: future },
        endBranch("d90_end"),
        { key: "c180", type: "condition", if: days(180), then: "d180", else: "end" },
        { key: "d180", type: "email", template: "inactivity-180", unless: future },
        { key: "tag_dormant", type: "tag", tag: "dormant", unless: future },
      ],
    }),
    templates: TEMPLATES,
  },
];
