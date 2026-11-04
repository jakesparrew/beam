/**
 * crm's `defaults` seed profile (runbook 3.4, BS-11, crm-P1): the system tags (`vip` and the
 * three starter interests) and version 1 of every consent wording in the three locales,
 * published. Idempotent (`on conflict do nothing`): existing rows are never changed, so staff
 * edits and later wording versions survive a re-run. Demo persons, companies and tasks are
 * demo data and live in `apps/web/modules/crm/seed.ts`.
 */
import type { DbOrTx } from "../client";
import type { LocalizedText } from "../schema/_shared";
import { consentWordings, tags } from "../schema/crm";
import type { DefaultSeed } from "./run";

type Purpose = (typeof consentWordings.$inferInsert)["purpose"];

export const SYSTEM_TAGS: readonly { key: string; name: Required<LocalizedText>; color: string; description: string }[] = [
  { key: "vip", name: { "nl-BE": "VIP", "fr-BE": "VIP", en: "VIP" }, color: "#b45309", description: "Very important person; segments and reception use it." },
  { key: "interest:sleep", name: { "nl-BE": "Interesse: slaap", "fr-BE": "Intérêt : sommeil", en: "Interest: sleep" }, color: "#4f46e5", description: "Interested in sleep programmes." },
  { key: "interest:breathwork", name: { "nl-BE": "Interesse: ademwerk", "fr-BE": "Intérêt : respiration", en: "Interest: breathwork" }, color: "#0d9488", description: "Interested in breathwork sessions." },
  { key: "interest:events", name: { "nl-BE": "Interesse: events", "fr-BE": "Intérêt : événements", en: "Interest: events" }, color: "#be185d", description: "Interested in events and workshops." },
];

/** Version 1 of every purpose (crm spec 2.3). */
export const CONSENT_WORDINGS_V1: Readonly<Record<Purpose, Required<LocalizedText>>> = {
  newsletter: {
    "nl-BE": "Ja, ik ontvang graag de nieuwsbrief van BEAM met nieuws, tips en aanbiedingen. Ik kan me op elk moment uitschrijven.",
    "fr-BE": "Oui, je souhaite recevoir la newsletter de BEAM avec des nouvelles, des conseils et des offres. Je peux me désinscrire à tout moment.",
    en: "Yes, I would like to receive the BEAM newsletter with news, tips and offers. I can unsubscribe at any time.",
  },
  events: {
    "nl-BE": "Ja, houd me op de hoogte van events, workshops en webinars van BEAM. Ik kan me op elk moment uitschrijven.",
    "fr-BE": "Oui, tenez-moi informé·e des événements, ateliers et webinaires de BEAM. Je peux me désinscrire à tout moment.",
    en: "Yes, keep me informed about BEAM events, workshops and webinars. I can unsubscribe at any time.",
  },
  member_comms: {
    "nl-BE": "Ja, stuur me berichten voor leden: nieuwe voordelen, ledenactiviteiten en uitnodigingen. Ik kan me op elk moment uitschrijven.",
    "fr-BE": "Oui, envoyez-moi les communications réservées aux membres : nouveaux avantages, activités et invitations. Je peux me désinscrire à tout moment.",
    en: "Yes, send me member communication: new benefits, member activities and invitations. I can unsubscribe at any time.",
  },
  b2b: {
    "nl-BE": "Ja, BEAM mag mij als zakelijk contact informeren over aanbod voor bedrijven en teams. Ik kan me op elk moment uitschrijven.",
    "fr-BE": "Oui, BEAM peut m'informer, en tant que contact professionnel, de ses offres pour les entreprises et les équipes. Je peux me désinscrire à tout moment.",
    en: "Yes, BEAM may inform me as a business contact about offers for companies and teams. I can unsubscribe at any time.",
  },
  assessment_result: {
    "nl-BE": "Ja, stuur me het resultaat van deze test per e-mail. Dit is geen inschrijving op de nieuwsbrief.",
    "fr-BE": "Oui, envoyez-moi le résultat de ce test par e-mail. Il ne s'agit pas d'une inscription à la newsletter.",
    en: "Yes, email me the result of this assessment. This is not a newsletter subscription.",
  },
  sensitive_processing: {
    "nl-BE": "Ik geef BEAM uitdrukkelijk toestemming om de gezondheidsgegevens die ik deel te verwerken om mijn begeleiding af te stemmen. Ik kan deze toestemming op elk moment intrekken.",
    "fr-BE": "Je donne expressément à BEAM mon consentement au traitement des données de santé que je partage, afin d'adapter mon accompagnement. Je peux retirer ce consentement à tout moment.",
    en: "I explicitly allow BEAM to process the health information I share in order to tailor my guidance. I can withdraw this consent at any time.",
  },
  ai_processing: {
    "nl-BE": "Ik ga ermee akkoord dat BEAM AI-hulpmiddelen gebruikt om antwoorden en aanbevelingen voor mij voor te bereiden. Een medewerker controleert alles. Ik kan dit op elk moment intrekken.",
    "fr-BE": "J'accepte que BEAM utilise des outils d'IA pour préparer des réponses et des recommandations à mon intention. Un membre de l'équipe vérifie tout. Je peux retirer cet accord à tout moment.",
    en: "I agree that BEAM uses AI tools to prepare answers and recommendations for me. A staff member checks everything. I can withdraw this at any time.",
  },
};

async function run(db: DbOrTx): Promise<void> {
  await db
    .insert(tags)
    .values(SYSTEM_TAGS.map((t) => ({ key: t.key, name: t.name, color: t.color, description: t.description, isSystem: true })))
    .onConflictDoNothing({ target: tags.key });
  const now = new Date();
  await db
    .insert(consentWordings)
    .values((Object.entries(CONSENT_WORDINGS_V1) as [Purpose, Required<LocalizedText>][]).map(([purpose, text]) => ({ purpose, version: 1, text, publishedAt: now })))
    .onConflictDoNothing();
}

export const seed: DefaultSeed = { after: ["platform"], run };
