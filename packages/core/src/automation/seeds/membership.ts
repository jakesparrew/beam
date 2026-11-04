/**
 * Membership journeys (spec 3.6): `member-welcome` on `membership.started` and
 * `membership-renewal` on `membership.renewal_due` (30 and 7 days; credits emits the monthly
 * 7-day event only for a missing mandate or a set `cancel_at`). Transactional journeys per
 * membership (`subject: ref`); the member-only marketing step uses purpose `member_comms`.
 */
import { c, DAY, definition, endBranch, fromEnrolment, seedTemplate, type SeedAutomation } from "./groups";

const t = (slug: string, name: string, path: string, copy: Parameters<typeof seedTemplate>[0]["copy"]) => seedTemplate({ slug, name, kind: "transactional", path, copy });

const WELCOME = [
  t("automation.member_welcome", "Automation: member welcome", "/account/membership", {
    "nl-BE": c("Welkom als lid van BEAM", "Alles wat je als lid moet weten.", "Welkom als lid", "Als lid krijg je inbegrepen sessies, toegang tot sessies voor leden en de ledenprijs. Opzeggen kan altijd via je account.", "Naar je lidmaatschap"),
    "fr-BE": c("Bienvenue parmi les membres de BEAM", "Tout ce qu'il faut savoir en tant que membre.", "Bienvenue parmi nos membres", "En tant que membre, vous bénéficiez de séances incluses, de séances réservées aux membres et du prix membre. Vous pouvez résilier à tout moment via votre compte.", "Vers votre abonnement"),
    en: c("Welcome as a BEAM member", "Everything you need to know as a member.", "Welcome as a member", "As a member you get included sessions, member-only sessions and the member price. You can cancel at any time in your account.", "Go to your membership"),
  }),
  seedTemplate({
    slug: "member-welcome-first-booking",
    name: "Member welcome: first booking",
    kind: "marketing",
    purpose: "member_comms",
    path: "/booking",
    copy: {
      "nl-BE": c("Plan je eerste sessie als lid", "Je inbegrepen sessies wachten op je.", "Je eerste sessie als lid", "Je lidmaatschap loopt. Boek nu je eerste inbegrepen sessie.", "Boek een sessie"),
      "fr-BE": c("Planifiez votre première séance de membre", "Vos séances incluses vous attendent.", "Votre première séance de membre", "Votre abonnement est actif. Réservez dès maintenant votre première séance incluse.", "Réserver une séance"),
      en: c("Plan your first session as a member", "Your included sessions are waiting.", "Your first member session", "Your membership is running. Book your first included session now.", "Book a session"),
    },
  }),
];

const RENEWAL = [
  t("automation.membership_renewal_30", "Automation: membership renewal 30 days", "/account/membership", {
    "nl-BE": c("Je lidmaatschap wordt over 30 dagen verlengd", "Een herinnering vooraf.", "Verlenging over 30 dagen", "Je lidmaatschap wordt over 30 dagen automatisch verlengd. Je gegevens nakijken kan in je account.", "Bekijk je lidmaatschap"),
    "fr-BE": c("Votre abonnement est renouvelé dans 30 jours", "Un rappel à l'avance.", "Renouvellement dans 30 jours", "Votre abonnement sera renouvelé automatiquement dans 30 jours. Vous pouvez vérifier vos données dans votre compte.", "Voir votre abonnement"),
    en: c("Your membership renews in 30 days", "A reminder in advance.", "Renewal in 30 days", "Your membership renews automatically in 30 days. You can check your details in your account.", "View your membership"),
  }),
  t("automation.membership_ending_7", "Automation: membership ending", "/account/membership", {
    "nl-BE": c("Je lidmaatschap eindigt binnenkort", "Toch verder? Verleng met één klik.", "Je lidmaatschap eindigt", "Je lidmaatschap eindigt over 7 dagen. Wil je toch lid blijven? Verleng het in je account.", "Verleng je lidmaatschap"),
    "fr-BE": c("Votre abonnement se termine bientôt", "Vous continuez ? Renouvelez en un clic.", "Votre abonnement se termine", "Votre abonnement se termine dans 7 jours. Vous souhaitez rester membre ? Renouvelez-le dans votre compte.", "Renouveler l'abonnement"),
    en: c("Your membership ends soon", "Staying after all? Renew in one click.", "Your membership ends", "Your membership ends in 7 days. Want to stay a member? Renew it in your account.", "Renew your membership"),
  }),
  t("automation.membership_renewal_7", "Automation: membership renewal 7 days", "/account/membership", {
    "nl-BE": c("Je lidmaatschap wordt over 7 dagen verlengd", "Controleer je betaalgegevens.", "Verlenging over 7 dagen", "Je lidmaatschap wordt over 7 dagen verlengd. Controleer of je betaalgegevens in orde zijn.", "Bekijk je lidmaatschap"),
    "fr-BE": c("Votre abonnement est renouvelé dans 7 jours", "Vérifiez vos données de paiement.", "Renouvellement dans 7 jours", "Votre abonnement sera renouvelé dans 7 jours. Vérifiez que vos données de paiement sont en ordre.", "Voir votre abonnement"),
    en: c("Your membership renews in 7 days", "Check your payment details.", "Renewal in 7 days", "Your membership renews in 7 days. Check that your payment details are in order.", "View your membership"),
  }),
];

const base = { groupKey: "membership", priority: 100, isMarketing: false, purpose: null, status: "active" as const, requiresDpia: null, requiresFlag: null, release: "V1" as const };

export const MEMBERSHIP_SEEDS: SeedAutomation[] = [
  {
    ...base,
    slug: "member-welcome",
    name: "Member welcome",
    description: "Welcome for a new member, a first-booking nudge and a first-month check task.",
    definition: definition({
      trigger: { event: "membership.started" },
      anchor: "enrolment",
      subject: "ref",
      re_entry: "never",
      exit_on: ["membership.cancelled", "membership.expired"],
      steps: [
        { key: "welcome", type: "email", template: "automation.member_welcome", at: fromEnrolment(0) },
        { key: "first_booking", type: "email", template: "member-welcome-first-booking", at: fromEnrolment(7 * DAY, "10:00"), unless: { has_future_booking: true } },
        { key: "month_check", type: "task", title: "Lid: eerste maand opvolgen", kind: "follow_up", owner_role: "customer_service", due_in_minutes: DAY, priority: "normal", at: fromEnrolment(30 * DAY) },
      ],
    }),
    templates: WELCOME,
  },
  {
    ...base,
    slug: "membership-renewal",
    name: "Membership renewal",
    description: "Renewal reminders 30 and 7 days before the period end, or an ending notice when the member cancels.",
    definition: definition({
      trigger: { event: "membership.renewal_due", where: { "data.days": { in: [30, 7] } } },
      anchor: "enrolment",
      subject: "ref",
      re_entry: "always",
      exit_on: ["membership.cancelled", "membership.renewed", "membership.expired"],
      steps: [
        { key: "c30", type: "condition", if: { trigger: { "data.days": 30 } }, then: "r30", else: "r7_branch" },
        { key: "r30", type: "email", template: "automation.membership_renewal_30", unless: { membership_cancelling: true } },
        endBranch("r30_end"),
        { key: "r7_branch", type: "condition", if: { membership_cancelling: true }, then: "r7_ending", else: "r7" },
        { key: "r7_ending", type: "email", template: "automation.membership_ending_7" },
        endBranch("r7_ending_end"),
        { key: "r7", type: "email", template: "automation.membership_renewal_7" },
      ],
    }),
    templates: RENEWAL,
  },
];
