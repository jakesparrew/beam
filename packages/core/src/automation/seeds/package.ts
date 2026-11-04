/**
 * Package journeys (spec 3.6): `package-usage` (thresholds 50, 75, 80, 90 % and the last unit of
 * a purchased day or night package), `package-expiry` (packages and gift vouchers, 30 and 7 days
 * before expiry) and `package-finished` (exhausted, not repurchased). Each journey is per grant
 * (`subject: ref`, `credit_grant:<id>`). Branch chains close with `endBranch` so one threshold
 * sends exactly one message.
 */
import { TRIGGER_CREDIT_KIND, type Condition } from "../definition";
import { c, DAY, definition, endBranch, fromEnrolment, seedTemplate, type SeedAutomation } from "./groups";

const otherGrant: Condition = { has_other_active_grant: { credit_kind: TRIGGER_CREDIT_KIND } };
/** Stop on a repurchase of the same credit kind (credits section 4). */
const repurchase = { event: "credits.granted", where: { "data.source": "purchase", "data.credit_kind": TRIGGER_CREDIT_KIND } };

const t = (slug: string, name: string, path: string, copy: Parameters<typeof seedTemplate>[0]["copy"]) => seedTemplate({ slug, name, kind: "transactional", path, copy });
const m = (slug: string, name: string, path: string, copy: Parameters<typeof seedTemplate>[0]["copy"]) => seedTemplate({ slug, name, kind: "marketing", purpose: "newsletter", path, copy });

const USAGE_TEMPLATES = [
  t("automation.package_usage_50", "Automation: package half used", "/account/credits", {
    "nl-BE": c("Je pakket is half gebruikt", "Een stand van zaken.", "Halfweg", "Je hebt de helft van je pakket gebruikt. Plan je volgende bezoeken in je account.", "Plan een bezoek"),
    "fr-BE": c("Votre forfait est à moitié utilisé", "Un point sur votre forfait.", "À mi-chemin", "Vous avez utilisé la moitié de votre forfait. Planifiez vos prochaines visites dans votre compte.", "Planifier une visite"),
    en: c("Your package is half used", "A quick update.", "Halfway", "You have used half of your package. Plan your next visits in your account.", "Plan a visit"),
  }),
  t("automation.package_usage_75", "Automation: package three quarters used", "/account/credits", {
    "nl-BE": c("Je pakket is voor driekwart gebruikt", "Nog een kwart te gaan.", "Nog een kwart", "Je hebt driekwart van je pakket gebruikt. Bekijk je resterende bezoeken in je account.", "Bekijk je tegoed"),
    "fr-BE": c("Votre forfait est utilisé aux trois quarts", "Plus qu'un quart.", "Plus qu'un quart", "Vous avez utilisé les trois quarts de votre forfait. Consultez vos visites restantes dans votre compte.", "Voir votre solde"),
    en: c("Your package is three quarters used", "One quarter to go.", "One quarter to go", "You have used three quarters of your package. See your remaining visits in your account.", "See your balance"),
  }),
  m("package-usage-90", "Package usage: almost done", "/shop", {
    "nl-BE": c("Je pakket is bijna op", "Verleng op tijd.", "Bijna op", "Je pakket is bijna volledig gebruikt. Koop tijdig een nieuw pakket, zo blijf je voordelig komen.", "Koop een nieuw pakket"),
    "fr-BE": c("Votre forfait est presque épuisé", "Renouvelez à temps.", "Presque épuisé", "Votre forfait est presque entièrement utilisé. Achetez un nouveau forfait à temps pour continuer à profiter du meilleur prix.", "Acheter un forfait"),
    en: c("Your package is almost used up", "Renew in time.", "Almost done", "Your package is almost used up. Buy a new package in time to keep the best price.", "Buy a new package"),
  }),
  m("package-usage-last", "Package usage: last session", "/shop", {
    "nl-BE": c("Je laatste sessie van je pakket", "Daarna kan je verder met een nieuw pakket.", "Je laatste sessie", "Je hebt nog één sessie in je pakket. Met een nieuw pakket ga je zonder onderbreking verder.", "Koop een nieuw pakket"),
    "fr-BE": c("La dernière séance de votre forfait", "Ensuite, continuez avec un nouveau forfait.", "Votre dernière séance", "Il vous reste une séance dans votre forfait. Avec un nouveau forfait, vous continuez sans interruption.", "Acheter un forfait"),
    en: c("The last session of your package", "Then continue with a new package.", "Your last session", "You have one session left in your package. With a new package you continue without a break.", "Buy a new package"),
  }),
];

const EXPIRY_TEMPLATES = [
  t("automation.voucher_expiry", "Automation: gift voucher expiry", "/account/credits", {
    "nl-BE": c("Je cadeaubon vervalt binnenkort", "Gebruik je tegoed op tijd.", "Je cadeaubon vervalt binnenkort", "Je cadeaubon vervalt binnenkort. Gebruik je tegoed voor een bezoek of in de shop.", "Bekijk je tegoed"),
    "fr-BE": c("Votre bon cadeau expire bientôt", "Utilisez votre solde à temps.", "Votre bon cadeau expire bientôt", "Votre bon cadeau expire bientôt. Utilisez votre solde pour une visite ou dans la boutique.", "Voir votre solde"),
    en: c("Your gift voucher expires soon", "Use your balance in time.", "Your gift voucher expires soon", "Your gift voucher expires soon. Use your balance for a visit or in the shop.", "See your balance"),
  }),
  t("automation.package_expiry", "Automation: package expiry", "/account/credits", {
    "nl-BE": c("Je pakket vervalt binnenkort", "Plan je resterende sessies.", "Je pakket vervalt binnenkort", "Je hebt nog sessies in je pakket, maar het vervalt binnenkort. Plan ze nu in.", "Plan een bezoek"),
    "fr-BE": c("Votre forfait expire bientôt", "Planifiez vos séances restantes.", "Votre forfait expire bientôt", "Il vous reste des séances dans votre forfait, mais il expire bientôt. Planifiez-les maintenant.", "Planifier une visite"),
    en: c("Your package expires soon", "Plan your remaining sessions.", "Your package expires soon", "You still have sessions in your package, but it expires soon. Plan them now.", "Plan a visit"),
  }),
];

const FINISHED_TEMPLATES = [
  m("package-finished-repurchase", "Package finished: repurchase", "/shop", {
    "nl-BE": c("Je pakket is op: zin in meer?", "Ga verder waar je gebleven was.", "Ga verder met BEAM", "Je pakket is volledig gebruikt. Met een nieuw pakket blijf je regelmatig komen.", "Bekijk de pakketten"),
    "fr-BE": c("Votre forfait est terminé : envie de plus ?", "Reprenez là où vous en étiez.", "Continuez avec BEAM", "Votre forfait est entièrement utilisé. Avec un nouveau forfait, vous continuez à venir régulièrement.", "Voir les forfaits"),
    en: c("Your package is finished: fancy more?", "Pick up where you left off.", "Continue with BEAM", "Your package is fully used. With a new package you keep coming regularly.", "See the packages"),
  }),
];

const pct = (value: number | "last_unit"): Condition => ({ trigger: { "data.pct": value } });

const base = { priority: 100, requiresDpia: null, requiresFlag: null, release: "V1" as const, status: "active" as const, groupKey: "package" };

export const PACKAGE_SEEDS: SeedAutomation[] = [
  {
    ...base,
    slug: "package-usage",
    name: "Package usage",
    description: "Usage messages at 50, 75, 80 and 90 % and the last unit of a day or night package.",
    isMarketing: false,
    purpose: null,
    definition: definition({
      trigger: { event: "credits.threshold_reached", where: { "data.credit_kind": { in: ["day", "night"] } } },
      anchor: "enrolment",
      subject: "ref",
      re_entry: "always",
      exit_on: [repurchase, "membership.started", { event: "credits.threshold_reached", same_subject: true }],
      steps: [
        { key: "c50", type: "condition", if: pct(50), then: "p50", else: "c75" },
        { key: "p50", type: "email", template: "automation.package_usage_50", unless: otherGrant },
        endBranch("p50_end"),
        { key: "c75", type: "condition", if: pct(75), then: "p75", else: "c80" },
        { key: "p75", type: "email", template: "automation.package_usage_75", unless: otherGrant },
        endBranch("p75_end"),
        { key: "c80", type: "condition", if: pct(80), then: "p80", else: "c90" },
        { key: "p80", type: "tag", tag: "package_nearly_used" },
        endBranch("p80_end"),
        { key: "c90", type: "condition", if: pct(90), then: "p90", else: "c_last" },
        { key: "p90", type: "email", template: "package-usage-90", unless: otherGrant },
        endBranch("p90_end"),
        { key: "c_last", type: "condition", if: pct("last_unit"), then: "last", else: "end" },
        { key: "last", type: "email", template: "package-usage-last", unless: otherGrant },
        { key: "last_task", type: "task", title: "Pakket bijna op: bel klant", kind: "call", owner_role: "customer_service", due_in_minutes: DAY, priority: "normal", at: { from: "previous", minutes: 3 * DAY } },
      ],
    }),
    templates: USAGE_TEMPLATES,
  },
  {
    ...base,
    slug: "package-expiry",
    name: "Package expiry",
    description: "Notice 30 and 7 days before a package or gift voucher expires.",
    isMarketing: false,
    purpose: null,
    definition: definition({
      trigger: { event: "credits.expiry_approaching", where: { "data.days": { in: [30, 7] } } },
      anchor: "enrolment",
      subject: "ref",
      re_entry: "always",
      exit_on: [
        { event: "credits.grant_exhausted", same_subject: true },
        { event: "credits.extended", same_subject: true },
      ],
      steps: [
        { key: "kind", type: "condition", if: { trigger: { "data.credit_kind": "euro" } }, then: "voucher_expiry", else: "package_expiry" },
        { key: "voucher_expiry", type: "email", template: "automation.voucher_expiry", at: fromEnrolment(0, "10:00") },
        endBranch("voucher_end"),
        { key: "package_expiry", type: "email", template: "automation.package_expiry", at: fromEnrolment(0, "10:00") },
      ],
    }),
    templates: EXPIRY_TEMPLATES,
  },
  {
    ...base,
    slug: "package-finished",
    name: "Package finished",
    description: "Repurchase email and a call task when a day or night package is used up and not repurchased.",
    isMarketing: true,
    purpose: "newsletter",
    definition: definition({
      trigger: { event: "credits.grant_exhausted", where: { "data.credit_kind": { in: ["day", "night"] } } },
      anchor: "enrolment",
      subject: "ref",
      re_entry: "after_days:30",
      exit_on: [repurchase, "membership.started"],
      steps: [
        { key: "repurchase", type: "email", template: "package-finished-repurchase", at: fromEnrolment(3 * DAY, "10:00"), unless: { any: [otherGrant, { has_active_membership: true }] } },
        { key: "call", type: "task", title: "Pakket op, niet herkocht", kind: "call", owner_role: "customer_service", due_in_minutes: DAY, priority: "normal", at: fromEnrolment(10 * DAY), unless: { event_since_enrolment: "credits.granted" } },
      ],
    }),
    templates: FINISHED_TEMPLATES,
  },
];
