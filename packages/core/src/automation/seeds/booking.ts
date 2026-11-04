/**
 * `after-first-booking` (spec 3.6): preparation and intake reminder before a first day or night
 * visit. No `confirm` and no `reminder` step: booking sends the confirmation and the day and night
 * reminders itself (booking R59, R60). The intake reminder is skipped when a health declaration
 * of the last year exists, and while `health-declaration` is not published (DM-15, D39).
 */
import { c, DAY, definition, fromAnchor, seedTemplate, type SeedAutomation } from "./groups";

/** The forms slug of the health declaration and waiver (forms seed, cross-module D39). */
export const HEALTH_DECLARATION_SLUG = "health-declaration";

const t = (slug: string, name: string, path: string, copy: Parameters<typeof seedTemplate>[0]["copy"]) => seedTemplate({ slug, name, kind: "transactional", path, copy });

export const FIRST_BOOKING_TEMPLATES = [
  t("automation.first_booking_preparation", "Automation: first booking preparation", "/account/bookings", {
    "nl-BE": c("Zo bereid je je eerste bezoek voor", "Wat je meebrengt en hoe je ons vindt.", "Klaar voor je eerste bezoek", "Breng comfortabele kleding mee, kom tien minuten vroeger en lees onze huisregels en openingsuren.", "Bekijk je boeking"),
    "fr-BE": c("Préparez votre première visite", "Ce qu'il faut apporter et comment nous trouver.", "Prêt·e pour votre première visite", "Apportez des vêtements confortables, arrivez dix minutes plus tôt et lisez notre règlement et nos horaires.", "Voir votre réservation"),
    en: c("How to prepare for your first visit", "What to bring and how to find us.", "Ready for your first visit", "Bring comfortable clothes, arrive ten minutes early and read our house rules and opening hours.", "View your booking"),
  }),
  t("automation.first_booking_intake_reminder", "Automation: first booking intake reminder", "/f/health-declaration", {
    "nl-BE": c("Vul je gezondheidsverklaring in vóór je bezoek", "Zo verloopt je ontvangst vlot.", "Nog één ding vóór je bezoek", "Vul je gezondheidsverklaring en afstandsverklaring online in, dan kan je meteen beginnen.", "Vul de verklaring in"),
    "fr-BE": c("Complétez votre déclaration de santé avant votre visite", "Pour un accueil rapide.", "Encore une chose avant votre visite", "Complétez en ligne votre déclaration de santé et la décharge, vous pourrez ainsi commencer tout de suite.", "Compléter la déclaration"),
    en: c("Fill in your health declaration before your visit", "So your welcome goes smoothly.", "One more thing before your visit", "Fill in your health declaration and waiver online, so you can start right away.", "Fill in the declaration"),
  }),
];

export const BOOKING_SEEDS: SeedAutomation[] = [
  {
    slug: "after-first-booking",
    name: "After first booking",
    description: "Preparation and intake reminder before a first day or night visit.",
    groupKey: "transactional",
    priority: 100,
    isMarketing: false,
    purpose: null,
    status: "active",
    requiresDpia: null,
    requiresFlag: null,
    release: "V1",
    definition: definition({
      trigger: { event: "booking.confirmed", where: { "data.is_first_booking": true, "data.session_kind": { in: ["day", "night"] } } },
      anchor: "data.starts_at",
      subject: "ref",
      re_entry: "always",
      exit_on: [
        { event: "booking.cancelled", same_subject: true },
        { event: "booking.late_cancelled", same_subject: true },
      ],
      steps: [
        { key: "preparation", type: "email", template: "automation.first_booking_preparation", at: fromAnchor(-2 * DAY, "10:00"), late_entry: "send_now" },
        {
          key: "intake_reminder",
          type: "email",
          template: "automation.first_booking_intake_reminder",
          at: fromAnchor(-DAY, "10:00"),
          late_entry: "send_now",
          unless: { any: [{ form_completed: { slug: HEALTH_DECLARATION_SLUG, within_days: 365 } }, { not: { form_available: HEALTH_DECLARATION_SLUG } }] },
        },
      ],
    }),
    templates: FIRST_BOOKING_TEMPLATES,
  },
];
