/**
 * webinar's `defaults` seed profile (runbook 3.4, BS-11; webinar spec 4.8 and section 8), also
 * run in production. It writes one row: the marketing template `webinar-follow-up` (purpose
 * `events`), the follow-up email the webinar behaviour journeys of automation send one hour after
 * the trigger. Its block document uses the merge fields `{{webinar.title}}`,
 * `{{webinar.starts_at_local}}` and `{{webinar.access_url}}`, resolved from the enrolment's
 * subject `registration_id`; it holds no `webinar` block (that block names one fixed webinar and
 * is for staff-built invitation campaigns).
 *
 * The five transactional system rows (`webinar.access`, `webinar.reminder`, ...) come from
 * email's registry seed, and the journeys from automation's seed; this module seeds neither
 * (cross-module D3, D52). `seedTemplate` never touches an existing slug, so BEAM's edits survive
 * a re-seed. `apps/web`'s `modules/webinar/seed.ts` runs the same writer with email's
 * `seedTemplate` api.
 */
import type { SeedTemplateInput } from "@beam/core/email";
import type { DbOrTx } from "../client";
import { insertSeededTemplate } from "./email";
import type { DefaultSeed } from "./run";

export const WEBINAR_FOLLOW_UP_SLUG = "webinar-follow-up";

type Copy = { subject: string; preheader: string; heading: string; text: string; cta: string };

const COPY: Record<"nl-BE" | "fr-BE" | "en", Copy> = {
  "nl-BE": {
    subject: "Bedankt voor je interesse in {{webinar.title}}",
    preheader: "Een volgende stap na de webinar",
    heading: "Bedankt om erbij te zijn",
    text: "Fijn dat je **{{webinar.title}}** ({{webinar.starts_at_local|de webinar}}) hebt gevolgd. Wil je het nog eens bekijken of iets nalezen? Met je persoonlijke link kom je meteen terug bij de webinar.\n\nHeb je vragen of wil je de volgende stap zetten? Antwoord gerust op deze e-mail.",
    cta: "Terug naar de webinar",
  },
  "fr-BE": {
    subject: "Merci pour votre intérêt pour {{webinar.title}}",
    preheader: "Une prochaine étape après le webinaire",
    heading: "Merci d’avoir été là",
    text: "Merci d’avoir suivi **{{webinar.title}}** ({{webinar.starts_at_local|le webinaire}}). Vous voulez le revoir ou relire un passage ? Votre lien personnel vous ramène directement au webinaire.\n\nDes questions ou envie de passer à l’étape suivante ? Répondez simplement à cet e-mail.",
    cta: "Retour au webinaire",
  },
  en: {
    subject: "Thank you for your interest in {{webinar.title}}",
    preheader: "A next step after the webinar",
    heading: "Thank you for joining",
    text: "Thank you for following **{{webinar.title}}** ({{webinar.starts_at_local|the webinar}}). Want to watch it again or look something up? Your personal link takes you straight back to the webinar.\n\nQuestions, or ready for the next step? Just reply to this email.",
    cta: "Back to the webinar",
  },
};

/** Stable 10-character block ids, so a re-seed produces the same document. */
const BLOCK_IDS = {
  "nl-BE": { heading: "wfunlhead1", text: "wfunltext1", cta: "wfunlcta01" },
  "fr-BE": { heading: "wfufrhead1", text: "wfufrtext1", cta: "wfufrcta01" },
  en: { heading: "wfuenhead1", text: "wfuentext1", cta: "wfuencta01" },
} as const;

/** The `email.seedTemplate` input of `webinar-follow-up` (all three locales complete). */
export function webinarFollowUpTemplate(): SeedTemplateInput {
  const locales = Object.fromEntries(
    (Object.keys(COPY) as Array<keyof typeof COPY>).map((l) => [
      l,
      [
        { id: BLOCK_IDS[l].heading, type: "heading", level: 1, text: COPY[l].heading },
        { id: BLOCK_IDS[l].text, type: "text", markdown: COPY[l].text },
        { id: BLOCK_IDS[l].cta, type: "button", label: COPY[l].cta, href: "{{webinar.access_url}}", style: "primary" },
      ],
    ]),
  ) as SeedTemplateInput["document"]["locales"];
  return {
    slug: WEBINAR_FOLLOW_UP_SLUG,
    name: "Webinar follow-up",
    kind: "marketing",
    purpose: "events",
    subject: { "nl-BE": COPY["nl-BE"].subject, "fr-BE": COPY["fr-BE"].subject, en: COPY.en.subject },
    preheader: { "nl-BE": COPY["nl-BE"].preheader, "fr-BE": COPY["fr-BE"].preheader, en: COPY.en.preheader },
    document: { schemaVersion: 1, locales },
  };
}

/** Writes one block-backed template when its slug is absent (`email.seedTemplate` or `insertSeededTemplate`). */
export type WebinarSeedTemplateWriter = (db: DbOrTx, input: SeedTemplateInput) => Promise<{ templateId: string; created: boolean }>;

/** The webinar defaults: the `webinar-follow-up` template; returns whether it was created. */
export async function seedWebinarRows(db: DbOrTx, opts: { seedTemplate?: WebinarSeedTemplateWriter } = {}): Promise<{ templates: number }> {
  const write = opts.seedTemplate ?? insertSeededTemplate;
  const { created } = await write(db, webinarFollowUpTemplate());
  return { templates: created ? 1 : 0 };
}

export const seed: DefaultSeed = {
  after: ["platform", "email"],
  run: async (db) => {
    await seedWebinarRows(db);
  },
};
