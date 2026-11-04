/**
 * `assessment-follow-up` (spec 3.6, decision 44): marketing follow-up of an assessment result.
 * It is a marketing journey, so a result without newsletter consent receives only forms'
 * transactional result email (A-14). Automation priority 50 supersedes `welcome-lead` (100) in
 * the exclusive `lead_nurture` group (A-15).
 */
import { c, DAY, definition, fromEnrolment, seedBlockId, seedTemplate, type SeedAutomation } from "./groups";

const result = seedTemplate({
  slug: "assessment-follow-up-result",
  name: "Assessment follow-up: result",
  kind: "marketing",
  purpose: "newsletter",
  path: "/booking",
  copy: {
    "nl-BE": c("Wat je assessmentresultaat voor jou betekent", "Een vervolg op je resultaat.", "Jouw resultaat, een stap verder", "Op basis van je resultaat hebben we enkele tips en een aanbod dat bij je past.", "Plan je bezoek"),
    "fr-BE": c("Ce que votre résultat signifie pour vous", "Une suite à votre résultat.", "Votre résultat, un pas plus loin", "Sur la base de votre résultat, nous avons quelques conseils et une offre qui vous correspond.", "Planifier votre visite"),
    en: c("What your assessment result means for you", "A follow-up on your result.", "Your result, one step further", "Based on your result we have a few tips and an offer that suits you.", "Plan your visit"),
  },
});

// The outcome block of email (spec 3.6): a dynamic block per person status with a fallback,
// inserted after the heading. BEAM adds the assessment-outcome variants with the real outcome keys.
const dynamicText = {
  "nl-BE": ["Als nieuwe bezoeker raden we je een BEAM Experience aan.", "Als klant kies je het pakket dat bij je resultaat past."],
  "fr-BE": ["En tant que nouveau visiteur, nous vous conseillons une BEAM Experience.", "En tant que client, choisissez le forfait adapté à votre résultat."],
  en: ["As a new visitor we recommend a BEAM Experience.", "As a customer, choose the package that fits your result."],
} as const;
for (const l of ["nl-BE", "fr-BE", "en"] as const) {
  const blocks = result.document.locales[l]!;
  blocks.splice(1, 0, {
    id: seedBlockId(`assessment-follow-up-result:${l}:outcome`),
    type: "dynamic",
    variants: [{ when: { status: "lead" }, blocks: [{ id: seedBlockId(`assessment-follow-up-result:${l}:lead`), type: "text", markdown: dynamicText[l][0] }] }],
    fallback: [{ id: seedBlockId(`assessment-follow-up-result:${l}:fallback`), type: "text", markdown: dynamicText[l][1] }],
  });
}

const experience = seedTemplate({
  slug: "assessment-follow-up-experience-invite",
  name: "Assessment follow-up: BEAM Experience invitation",
  kind: "marketing",
  purpose: "newsletter",
  path: "/events",
  copy: {
    "nl-BE": c("Ervaar zelf wat BEAM voor je doet", "Een uitnodiging na je assessment.", "Kom naar een BEAM Experience", "Je resultaat is een begin. Tijdens een BEAM Experience voel je zelf het verschil.", "Bekijk de data"),
    "fr-BE": c("Découvrez ce que BEAM fait pour vous", "Une invitation après votre test.", "Venez à une BEAM Experience", "Votre résultat est un début. Lors d'une BEAM Experience, vous sentez vous-même la différence.", "Voir les dates"),
    en: c("Feel what BEAM does for you", "An invitation after your assessment.", "Come to a BEAM Experience", "Your result is a start. At a BEAM Experience you feel the difference yourself.", "See the dates"),
  },
});

export const ASSESSMENT_SEEDS: SeedAutomation[] = [
  {
    slug: "assessment-follow-up",
    name: "Assessment follow-up",
    description: "Marketing follow-up after an assessment result, with a sales task to discuss the result.",
    groupKey: "lead_nurture",
    priority: 50,
    isMarketing: true,
    purpose: "newsletter",
    status: "active",
    requiresDpia: null,
    requiresFlag: null,
    release: "V1",
    definition: definition({
      trigger: { event: "assessment.result_generated" },
      anchor: "enrolment",
      audience: { status: ["lead", "customer"] },
      re_entry: "after_days:30",
      exit_on: ["order.paid", "booking.confirmed", "membership.started"],
      steps: [
        { key: "result_follow_up", type: "email", template: "assessment-follow-up-result", at: fromEnrolment(DAY, "10:00") },
        { key: "sales_task", type: "task", title: "Bespreek assessmentresultaat", kind: "follow_up", owner_role: "sales", due_in_minutes: DAY, priority: "normal", at: fromEnrolment(DAY), unless: { any: [{ has_future_booking: true }, { status_in: ["member"] }] } },
        { key: "experience_invite", type: "email", template: "assessment-follow-up-experience-invite", at: fromEnrolment(4 * DAY, "10:00"), unless: { has_future_booking: true } },
      ],
    }),
    templates: [result, experience],
  },
];
