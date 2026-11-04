/**
 * Seeded form definitions (forms spec section 12, forms-P2; rules P6, P13, cross-module D15 and
 * D39): the system forms `contact`, `newsletter` and `health-declaration` of the `defaults`
 * seed, and the demo assessment `recovery-check` of the `demo` seed. Every definition passes
 * `validateForPublish` with zero errors (definition.test.ts).
 */
import type { LocalizedText } from "../i18n/localized-text";
import type { Locale } from "../i18n/locales";
import type { Cta, Field, FormDefinition, FormKind, FormScoring, Range } from "./types";

/** P13: stable slugs other modules read; never renamed, archived or deleted. */
export const SYSTEM_FORM_SLUGS = ["contact", "newsletter", "health-declaration"] as const;
export type SystemFormSlug = (typeof SYSTEM_FORM_SLUGS)[number];

export type SeedForm = { kind: FormKind; name: LocalizedText; definition: FormDefinition; scoring: FormScoring; locales: Locale[] };

const ALL: Locale[] = ["nl-BE", "fr-BE", "en"];
const t = (nl: string, fr: string, en: string): Required<LocalizedText> => ({ "nl-BE": nl, "fr-BE": fr, en });
const NO_SCORING: FormScoring = { dimensions: [], outcomes: [] };

const BASE = { required: false, sensitive: false } as const;

const email = (): Field => ({ ...BASE, key: "email", type: "email", label: t("E-mailadres", "Adresse e-mail", "Email address"), required: true, mapsTo: "person.email" });
const firstName = (required: boolean): Field => ({ ...BASE, key: "first_name", type: "short_text", label: t("Voornaam", "Prénom", "First name"), required, mapsTo: "person.first_name", maxLength: 100 });
const lastName = (required: boolean): Field => ({ ...BASE, key: "last_name", type: "short_text", label: t("Achternaam", "Nom", "Last name"), required, mapsTo: "person.last_name", maxLength: 100 });

const NEWSLETTER_WORDING = t(
  "Ja, ik ontvang graag de nieuwsbrief van BEAM met nieuws, tips en aanbiedingen. Ik kan me op elk moment uitschrijven.",
  "Oui, je souhaite recevoir la newsletter de BEAM avec des nouvelles, des conseils et des offres. Je peux me désinscrire à tout moment.",
  "Yes, I would like to receive the BEAM newsletter with news, tips and offers. I can unsubscribe at any time.",
);
const SENSITIVE_WORDING = t(
  "Ik geef BEAM uitdrukkelijk toestemming om de gezondheidsgegevens die ik deel te verwerken om mijn begeleiding af te stemmen. Ik kan deze toestemming op elk moment intrekken.",
  "Je donne expressément à BEAM mon consentement au traitement des données de santé que je partage, afin d'adapter mon accompagnement. Je peux retirer ce consentement à tout moment.",
  "I explicitly allow BEAM to process the health information I share in order to tailor my guidance. I can withdraw this consent at any time.",
);

const newsletterConsent = (required: boolean): Field => ({
  ...BASE,
  key: "newsletter",
  type: "consent",
  purpose: "newsletter",
  required,
  label: t("Nieuwsbrief", "Newsletter", "Newsletter"),
  wording: NEWSLETTER_WORDING,
});
const sensitiveConsent = (): Field => ({
  ...BASE,
  key: "sensitive_consent",
  type: "consent",
  purpose: "sensitive_processing",
  required: true,
  label: t("Toestemming voor gezondheidsgegevens", "Consentement pour les données de santé", "Consent for health information"),
  wording: SENSITIVE_WORDING,
});

const settings = (over: Partial<FormDefinition["settings"]> & Pick<FormDefinition["settings"], "submitLabel">): FormDefinition["settings"] => ({
  resumeEnabled: false,
  resumeDays: 7,
  skipKnownFields: true,
  capturePartialLeads: false,
  showProgress: true,
  sendResultEmail: false,
  createInboxThread: false,
  staffEntryAllowed: false,
  ...over,
});

const byKey = (fields: Field[]): Record<string, Field> => Object.fromEntries(fields.map((f) => [f.key, f]));

function contact(): SeedForm {
  const fields: Field[] = [
    email(),
    firstName(true),
    { ...BASE, key: "message", type: "long_text", label: t("Je bericht", "Votre message", "Your message"), required: true, sensitive: false, maxLength: 5000 },
    newsletterConsent(false),
  ];
  return {
    kind: "lead",
    name: t("Contactformulier", "Formulaire de contact", "Contact form"),
    locales: ALL,
    scoring: NO_SCORING,
    definition: {
      title: t("Contacteer ons", "Contactez-nous", "Contact us"),
      intro: t(
        "Heb je een vraag over BEAM? Laat een bericht achter en we antwoorden binnen twee werkdagen.",
        "Une question sur BEAM ? Laissez-nous un message et nous vous répondons dans les deux jours ouvrables.",
        "Do you have a question about BEAM? Leave a message and we will reply within two working days.",
      ),
      settings: settings({ submitLabel: t("Versturen", "Envoyer", "Send"), createInboxThread: true, funnel: "contact" }),
      sections: [{ key: "contact", fieldKeys: fields.map((f) => f.key) }],
      fields: byKey(fields),
      logic: [],
      endings: [
        {
          key: "thanks",
          kind: "thank_you",
          title: t("Bedankt voor je bericht", "Merci pour votre message", "Thank you for your message"),
          body: t(
            "We hebben je bericht goed ontvangen en nemen snel contact met je op.",
            "Nous avons bien reçu votre message et revenons vers vous rapidement.",
            "We have received your message and will get back to you soon.",
          ),
          showScore: false,
          showDimensions: [],
          ctas: [],
        },
      ],
    },
  };
}

function newsletter(): SeedForm {
  const fields: Field[] = [email(), firstName(false), newsletterConsent(true)];
  return {
    kind: "lead",
    name: t("Nieuwsbrief", "Newsletter", "Newsletter"),
    locales: ALL,
    scoring: NO_SCORING,
    definition: {
      title: t("Schrijf je in op de nieuwsbrief", "Inscrivez-vous à la newsletter", "Subscribe to the newsletter"),
      intro: t(
        "Ontvang tips over slaap, herstel en ontspanning, en hoor als eerste over nieuwe events.",
        "Recevez des conseils sur le sommeil, la récupération et la détente, et soyez informé·e en premier des nouveaux événements.",
        "Get tips on sleep, recovery and relaxation, and be the first to hear about new events.",
      ),
      settings: settings({ submitLabel: t("Inschrijven", "M'inscrire", "Subscribe"), funnel: "newsletter" }),
      sections: [{ key: "signup", fieldKeys: fields.map((f) => f.key) }],
      fields: byKey(fields),
      logic: [],
      endings: [
        {
          key: "thanks",
          kind: "thank_you",
          title: t("Bedankt!", "Merci !", "Thank you!"),
          body: t(
            "Bedankt voor je inschrijving. Je ontvangt binnenkort onze eerste nieuwsbrief.",
            "Merci pour votre inscription. Vous recevrez bientôt notre première newsletter.",
            "Thank you for subscribing. You will receive our first newsletter soon.",
          ),
          showScore: false,
          showDimensions: [],
          ctas: [],
        },
      ],
    },
  };
}

const HEALTH_QUESTIONS: [string, Required<LocalizedText>][] = [
  ["heart_condition", t("Heb je een hartaandoening of hartritmestoornis?", "Avez-vous une maladie cardiaque ou un trouble du rythme cardiaque ?", "Do you have a heart condition or an irregular heartbeat?")],
  ["blood_pressure", t("Heb je een te hoge of te lage bloeddruk?", "Avez-vous une tension artérielle trop élevée ou trop basse ?", "Do you have high or low blood pressure?")],
  ["pregnancy", t("Ben je zwanger?", "Êtes-vous enceinte ?", "Are you pregnant?")],
  ["epilepsy", t("Heb je epilepsie of heb je ooit een aanval gehad?", "Souffrez-vous d'épilepsie ou avez-vous déjà fait une crise ?", "Do you have epilepsy or have you ever had a seizure?")],
  ["recent_surgery", t("Heb je de voorbije zes weken een operatie gehad?", "Avez-vous été opéré·e au cours des six dernières semaines ?", "Have you had surgery in the last six weeks?")],
  ["skin_condition", t("Heb je een huidaandoening, open wonde of infectie?", "Avez-vous une affection cutanée, une plaie ouverte ou une infection ?", "Do you have a skin condition, an open wound or an infection?")],
  [
    "medication",
    t(
      "Neem je medicatie die je bloeddruk, hartslag of temperatuurgevoel beïnvloedt?",
      "Prenez-vous des médicaments qui influencent votre tension, votre rythme cardiaque ou votre perception de la température ?",
      "Do you take medication that affects your blood pressure, heart rate or sense of temperature?",
    ),
  ],
  ["alcohol_recent", t("Heb je de voorbije 4 uur alcohol gedronken?", "Avez-vous bu de l'alcool au cours des 4 dernières heures ?", "Have you drunk alcohol in the last 4 hours?")],
];

function healthDeclaration(): SeedForm {
  const identity: Field[] = [
    email(),
    firstName(true),
    lastName(true),
    { ...BASE, key: "birth_on", type: "date", label: t("Geboortedatum", "Date de naissance", "Date of birth"), required: true, mapsTo: "person.birth_on", min: "1900-01-01" },
    { ...BASE, key: "phone", type: "phone", label: t("Telefoonnummer", "Numéro de téléphone", "Phone number"), mapsTo: "person.phone" },
    sensitiveConsent(),
  ];
  const health: Field[] = [
    ...HEALTH_QUESTIONS.map(([key, label]): Field => ({ ...BASE, key, type: "yes_no", label, required: true, sensitive: true, sensitiveKind: "health" })),
    {
      ...BASE,
      key: "health_notes",
      type: "long_text",
      label: t("Is er nog iets over je gezondheid dat we moeten weten?", "Y a-t-il autre chose concernant votre santé que nous devrions savoir ?", "Is there anything else about your health we should know?"),
      sensitive: true,
      sensitiveKind: "health",
      maxLength: 2000,
    },
  ];
  const confirm: Field[] = [
    {
      ...BASE,
      key: "contraindications",
      type: "acknowledgement",
      required: true,
      label: t("Contra-indicaties", "Contre-indications", "Contraindications"),
      text: t(
        "Ik heb de contra-indicaties gelezen: bij een hart- of vaatziekte, zwangerschap, epilepsie, een recente operatie of na alcoholgebruik raadpleeg ik eerst een arts en gebruik ik de sauna, het koudwaterbad en ademwerk niet zonder diens akkoord. Ik verklaar dat mijn antwoorden juist zijn en meld wijzigingen aan BEAM.",
        "J'ai lu les contre-indications : en cas de maladie cardiovasculaire, de grossesse, d'épilepsie, d'opération récente ou après avoir bu de l'alcool, je consulte d'abord un médecin et je n'utilise pas le sauna, le bain froid ni la respiration sans son accord. Je déclare que mes réponses sont exactes et je signale tout changement à BEAM.",
        "I have read the contraindications: with a heart or vascular condition, pregnancy, epilepsy, recent surgery or after drinking alcohol I first consult a doctor and do not use the sauna, the cold plunge or breathwork without their approval. I declare that my answers are correct and I will tell BEAM about any change.",
      ),
    },
  ];
  return {
    kind: "intake",
    name: t("Gezondheidsverklaring", "Déclaration de santé", "Health declaration"),
    locales: ALL,
    scoring: NO_SCORING,
    definition: {
      title: t("Gezondheidsverklaring", "Déclaration de santé", "Health declaration"),
      intro: t(
        "Voor je veiligheid stellen we je enkele vragen over je gezondheid voor je de sauna, het koudwaterbad of een ademwerksessie gebruikt. Je antwoorden worden versleuteld bewaard en enkel bevoegde medewerkers kunnen ze inkijken.",
        "Pour votre sécurité, nous vous posons quelques questions sur votre santé avant que vous utilisiez le sauna, le bain froid ou une séance de respiration. Vos réponses sont conservées de manière chiffrée et seul le personnel autorisé peut les consulter.",
        "For your safety we ask a few questions about your health before you use the sauna, the cold plunge or a breathwork session. Your answers are stored encrypted and only authorised staff can read them.",
      ),
      settings: settings({ submitLabel: t("Verklaring versturen", "Envoyer la déclaration", "Send declaration"), validityDays: 365, staffEntryAllowed: true, funnel: "health-declaration" }),
      sections: [
        { key: "identity", title: t("Over jou", "À propos de vous", "About you"), fieldKeys: identity.map((f) => f.key) },
        { key: "health", title: t("Je gezondheid", "Votre santé", "Your health"), fieldKeys: health.map((f) => f.key) },
        { key: "confirm", title: t("Bevestiging", "Confirmation", "Confirmation"), fieldKeys: confirm.map((f) => f.key) },
      ],
      fields: byKey([...identity, ...health, ...confirm]),
      logic: [],
      endings: [
        {
          key: "thanks",
          kind: "thank_you",
          title: t("Bedankt, je verklaring is ontvangen", "Merci, votre déclaration a bien été reçue", "Thank you, your declaration has been received"),
          body: t(
            "Je verklaring blijft een jaar geldig. Heb je een van de vragen met ja beantwoord? Bespreek het dan met ons team voor je sessie.",
            "Votre déclaration reste valable un an. Avez-vous répondu oui à l'une des questions ? Parlez-en avec notre équipe avant votre séance.",
            "Your declaration stays valid for one year. Did you answer yes to any question? Please talk to our team before your session.",
          ),
          showScore: false,
          showDimensions: [],
          ctas: [],
        },
      ],
    },
  };
}

/** The three system forms of the `defaults` seed (fresh objects on every call). */
export function seedDefinitions(): Record<SystemFormSlug, SeedForm> {
  return { contact: contact(), newsletter: newsletter(), "health-declaration": healthDeclaration() };
}

// ---------------------------------------------------------------------------
// Demo assessment `recovery-check` (demo seed only)
// ---------------------------------------------------------------------------

/** CTA targets of the demo assessment; a missing id turns that button into a `url` CTA on `baseUrl`. */
export type RecoveryCheckRefs = { baseUrl: string; dayTemplateId?: string; nightTemplateId?: string; eventSessionId?: string };

const range = (key: string, from: number, to: number, label: Required<LocalizedText>, explanation?: Required<LocalizedText>): Range => ({ key, from, to, label, ...(explanation ? { explanation } : {}) });
const LOW = t("Laag", "Faible", "Low");
const MID = t("Gemiddeld", "Moyen", "Medium");
const HIGH = t("Hoog", "Élevé", "High");
const opt = (key: string, label: Required<LocalizedText>, scores: Record<string, number>) => ({ key, label, scores });

type DemoCtaKind = "booking" | "experience" | "event";
const CTA_LABELS: Record<DemoCtaKind, Required<LocalizedText>> = {
  booking: t("Boek een dagsessie", "Réserver une séance de jour", "Book a day session"),
  experience: t("Ontdek de BEAM Experience", "Découvrir la BEAM Experience", "Discover the BEAM Experience"),
  event: t("Kom naar ons volgende event", "Venez à notre prochain événement", "Join our next event"),
};

function demoCta(kind: DemoCtaKind, refs: RecoveryCheckRefs, key: string): Cta {
  const label = CTA_LABELS[kind];
  const id = kind === "event" ? refs.eventSessionId : kind === "experience" ? (refs.nightTemplateId ?? refs.dayTemplateId) : refs.dayTemplateId;
  if (!id) return { key, kind: "url", label, url: `${refs.baseUrl.replace(/\/+$/, "")}/nl` };
  return kind === "event" ? { key, kind, label, sessionId: id } : { key, kind, label, sessionTemplateId: id };
}

function recoveryFields(): { about: Field[]; body: Field[]; habits: Field[] } {
  const about: Field[] = [email(), firstName(true), sensitiveConsent(), newsletterConsent(false)];
  const body: Field[] = [
    {
      ...BASE,
      key: "sleep_hours",
      type: "single_choice",
      required: true,
      sensitive: true,
      sensitiveKind: "sleep",
      label: t("Hoeveel uur slaap je gemiddeld per nacht?", "Combien d'heures dormez-vous en moyenne par nuit ?", "How many hours do you sleep on average per night?"),
      options: [
        opt("lt5", t("Minder dan 5 uur", "Moins de 5 heures", "Less than 5 hours"), { sleep: 0 }),
        opt("5_6", t("5 tot 6 uur", "5 à 6 heures", "5 to 6 hours"), { sleep: 3 }),
        opt("7_8", t("7 tot 8 uur", "7 à 8 heures", "7 to 8 hours"), { sleep: 6 }),
        opt("gt8", t("Meer dan 8 uur", "Plus de 8 heures", "More than 8 hours"), { sleep: 5 }),
      ],
    },
    { ...BASE, key: "sleep_quality", type: "rating", scale: 5, required: true, sensitive: true, sensitiveKind: "sleep", weights: { sleep: 1 }, label: t("Hoe goed slaap je?", "Comment dormez-vous ?", "How well do you sleep?") },
    { ...BASE, key: "stress_level", type: "rating", scale: 10, required: true, sensitive: true, sensitiveKind: "stress", weights: { stress: 1 }, label: t("Hoeveel stress ervaar je deze weken?", "Quel niveau de stress ressentez-vous ces semaines-ci ?", "How much stress do you feel these weeks?") },
    {
      ...BASE,
      key: "stress_physical",
      type: "yes_no",
      sensitive: true,
      sensitiveKind: "stress",
      scores: { yes: { stress: 8 }, no: { stress: 2 } },
      visibleIf: { field: "stress_level", op: "gte", value: 6 },
      label: t("Voel je de stress ook lichamelijk (spanning, hoofdpijn)?", "Ressentez-vous aussi le stress physiquement (tensions, maux de tête) ?", "Do you also feel the stress physically (tension, headaches)?"),
    },
  ];
  const habits: Field[] = [
    {
      ...BASE,
      key: "movement",
      type: "single_choice",
      required: true,
      label: t("Hoe vaak beweeg je minstens 30 minuten?", "À quelle fréquence bougez-vous au moins 30 minutes ?", "How often do you exercise for at least 30 minutes?"),
      options: [
        opt("rarely", t("Zelden", "Rarement", "Rarely"), { habits: 0 }),
        opt("weekly", t("Eén keer per week", "Une fois par semaine", "Once a week"), { habits: 3 }),
        opt("several", t("Meerdere keren per week", "Plusieurs fois par semaine", "Several times a week"), { habits: 6 }),
        opt("daily", t("Elke dag", "Tous les jours", "Every day"), { habits: 8 }),
      ],
    },
    {
      ...BASE,
      key: "screen_time",
      type: "single_choice",
      required: true,
      label: t("Hoeveel uur per dag zit je buiten je werk achter een scherm?", "Combien d'heures par jour passez-vous devant un écran en dehors du travail ?", "How many hours a day do you spend on screens outside work?"),
      options: [
        opt("lt1", t("Minder dan 1 uur", "Moins d'une heure", "Less than 1 hour"), { habits: 6 }),
        opt("1_3", t("1 tot 3 uur", "1 à 3 heures", "1 to 3 hours"), { habits: 4 }),
        opt("3_5", t("3 tot 5 uur", "3 à 5 heures", "3 to 5 hours"), { habits: 2 }),
        opt("gt5", t("Meer dan 5 uur", "Plus de 5 heures", "More than 5 hours"), { habits: 0 }),
      ],
    },
    {
      ...BASE,
      key: "recovery_practices",
      type: "multiple_choice",
      label: t("Wat doe je nu al om te herstellen?", "Que faites-vous déjà pour récupérer ?", "What do you already do to recover?"),
      options: [
        opt("sauna", t("Sauna", "Sauna", "Sauna"), { habits: 3 }),
        opt("breathwork", t("Ademwerk", "Respiration", "Breathwork"), { habits: 3 }),
        opt("meditation", t("Meditatie", "Méditation", "Meditation"), { habits: 3 }),
        opt("walks", t("Wandelen in de natuur", "Marcher dans la nature", "Walks in nature"), { habits: 3 }),
      ],
    },
    { ...BASE, key: "cold_exposure", type: "yes_no", scores: { yes: { habits: 4 }, no: { habits: 0 } }, label: t("Neem je weleens een koude douche of koudwaterbad?", "Prenez-vous parfois une douche froide ou un bain froid ?", "Do you sometimes take a cold shower or a cold plunge?") },
  ];
  return { about, body, habits };
}

function recoveryScoring(): FormScoring {
  return {
    dimensions: [
      { key: "sleep", label: t("Slaap", "Sommeil", "Sleep"), kind: "sum", min: 0, max: 11, ranges: [range("low", 0, 5, LOW), range("fair", 5, 8, MID), range("good", 8, 11, HIGH)] },
      { key: "stress", label: t("Stress", "Stress", "Stress"), kind: "avg", min: 0, max: 10, ranges: [range("low", 0, 4, LOW), range("medium", 4, 7, MID), range("high", 7, 10, HIGH)] },
      {
        key: "habits",
        label: t("Herstelgewoonten", "Habitudes de récupération", "Recovery habits"),
        kind: "sum",
        min: 0,
        max: 30,
        ranges: [
          range("low", 0, 10, LOW, t("Je dagelijkse gewoonten laten weinig ruimte voor herstel.", "Vos habitudes quotidiennes laissent peu de place à la récupération.", "Your daily habits leave little room for recovery.")),
          range("medium", 10, 20, MID, t("Je hebt al goede gewoonten, met ruimte om te groeien.", "Vous avez déjà de bonnes habitudes, avec de la marge pour progresser.", "You already have good habits, with room to grow.")),
          range("high", 20, 30, HIGH, t("Herstel is een vast deel van je leven.", "La récupération fait partie intégrante de votre vie.", "Recovery is a steady part of your life.")),
        ],
      },
    ],
    total: { kind: "formula", formula: "round(dim.habits / 30 * 100)", ranges: [range("low", 0, 34, LOW), range("medium", 34, 67, MID), range("high", 67, 100, HIGH)] },
    outcomes: [
      {
        key: "reset_now",
        priority: 1,
        label: t("Tijd voor een reset", "L'heure d'une remise à zéro", "Time for a reset"),
        when: { all: [{ range: { dimension: "habits", key: "low" } }, { field: "screen_time", op: "in", value: ["3_5", "gt5"] }] },
        endingKey: "result_reset",
        tagKeys: ["interest:sleep"],
        recommendation: t("Begin met een BEAM-dag om volledig tot rust te komen.", "Commencez par une journée BEAM pour vous ressourcer complètement.", "Start with a BEAM day to fully unwind."),
      },
      {
        key: "build_routine",
        priority: 2,
        label: t("Bouw een routine op", "Construisez une routine", "Build a routine"),
        when: { range: { dimension: "habits", key: "low" } },
        endingKey: "result_reset",
        tagKeys: [],
        recommendation: t("Plan elke week een vast hersteluur in.", "Prévoyez chaque semaine une heure fixe de récupération.", "Plan a fixed recovery hour every week."),
      },
      { key: "keep_going", priority: 3, label: t("Goed bezig", "Sur la bonne voie", "On the right track"), when: { range: { dimension: "habits", key: "medium" } }, endingKey: "result_balance", tagKeys: [] },
      {
        key: "recovery_pro",
        priority: 4,
        label: t("Herstelprofessional", "Pro de la récupération", "Recovery pro"),
        when: { any: [{ range: { dimension: "habits", key: "high" } }, { all: [{ field: "cold_exposure", op: "eq", value: true }, { field: "movement", op: "eq", value: "daily" }] }] },
        endingKey: "result_pro",
        tagKeys: ["interest:breathwork"],
      },
    ],
    defaultOutcomeKey: "keep_going",
  };
}

/** The demo assessment: 3 sections, 12 fields, dimensions `sleep` and `stress` (sensitive) and `habits`, 4 outcomes. */
export function recoveryCheckSeed(refs: RecoveryCheckRefs): SeedForm {
  const { about, body, habits } = recoveryFields();
  const email_ = {
    subject: t("Je resultaat van de herstelcheck", "Votre résultat du bilan récupération", "Your recovery check result"),
    intro: t("Bedankt om de herstelcheck in te vullen. Dit is je resultaat.", "Merci d'avoir rempli le bilan récupération. Voici votre résultat.", "Thank you for taking the recovery check. Here is your result."),
  };
  const ending = (key: string, title: Required<LocalizedText>, text: Required<LocalizedText>, ctas: Cta[]): FormDefinition["endings"][number] => ({
    key,
    kind: "result",
    title,
    body: text,
    showScore: true,
    showDimensions: ["sleep", "stress", "habits"],
    ctas,
    email: email_,
  });
  return {
    kind: "assessment",
    name: t("Herstelcheck", "Bilan récupération", "Recovery check"),
    locales: ALL,
    scoring: recoveryScoring(),
    definition: {
      title: t("Herstelcheck", "Bilan récupération", "Recovery check"),
      intro: t("Ontdek in drie minuten hoe goed je herstelt.", "Découvrez en trois minutes comment vous récupérez.", "Find out in three minutes how well you recover."),
      settings: settings({ submitLabel: t("Bekijk mijn resultaat", "Voir mon résultat", "See my result"), sendResultEmail: true, resumeEnabled: true, funnel: "recovery-assessment" }),
      sections: [
        { key: "about", title: t("Over jou", "À propos de vous", "About you"), fieldKeys: about.map((f) => f.key) },
        { key: "sleep_stress", title: t("Slaap en stress", "Sommeil et stress", "Sleep and stress"), fieldKeys: body.map((f) => f.key) },
        { key: "habits", title: t("Gewoonten", "Habitudes", "Habits"), fieldKeys: habits.map((f) => f.key) },
      ],
      fields: byKey([...about, ...body, ...habits]),
      logic: [],
      endings: [
        ending(
          "result_reset",
          t("Je lichaam vraagt om rust", "Votre corps a besoin de repos", "Your body asks for rest"),
          t("Je herstel staat onder druk. Een rustmoment bij BEAM helpt je opnieuw op te laden.", "Votre récupération est sous pression. Un moment de calme chez BEAM vous aide à recharger vos batteries.", "Your recovery is under pressure. A quiet moment at BEAM helps you recharge."),
          [demoCta("experience", refs, "experience"), demoCta("booking", refs, "book")],
        ),
        ending(
          "result_balance",
          t("Je bent goed op weg", "Vous êtes sur la bonne voie", "You are on the right track"),
          t("Je hebt een goede basis. Met een vaste routine haal je er nog meer uit.", "Vous avez une bonne base. Avec une routine régulière, vous en tirerez encore plus.", "You have a good base. A steady routine gets you even more out of it."),
          [demoCta("booking", refs, "book"), demoCta("event", refs, "event")],
        ),
        ending(
          "result_pro",
          t("Herstel zit in je dagelijks leven", "La récupération fait partie de votre quotidien", "Recovery is part of your daily life"),
          t("Proficiat! Verdiep je praktijk tijdens een van onze events.", "Félicitations ! Approfondissez votre pratique lors de l'un de nos événements.", "Well done! Deepen your practice at one of our events."),
          [demoCta("event", refs, "event"), demoCta("experience", refs, "experience")],
        ),
      ],
    },
  };
}
