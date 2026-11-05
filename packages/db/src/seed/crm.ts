/**
 * crm's `defaults` seed profile (runbook 3.4, BS-11, crm-P1): the system tags (`vip` and the
 * three starter interests), version 1 of every
 * consent wording in the three locales, published, and (R3, crm-P8) the default sales playbook
 * (`DEFAULT_B2B_PLAYBOOK`: 13 stages, `DEFAULT_B2C_PLAYBOOK`: 10 stages). Idempotent (`on conflict do nothing`): existing rows are never changed, so staff
 * edits and later wording versions survive a re-run. Demo persons, companies and tasks are
 * demo data and live in `apps/web/modules/crm/seed.ts`.
 */
import type { DbOrTx } from "../client";
import type { LocalizedText } from "../schema/_shared";
import { consentWordings, playbookStages, tags, type PlaybookEscalationJson, type PlaybookKpiJson } from "../schema/crm";
import type { DefaultSeed } from "./run";

type Purpose = (typeof consentWordings.$inferInsert)["purpose"];

export const SYSTEM_TAGS: readonly { key: string; name: Required<LocalizedText>; color: string; description: string }[] = [
  { key: "vip", name: { "nl-BE": "VIP", "fr-BE": "VIP", en: "VIP" }, color: "#b45309", description: "Very important person; segments and reception use it." },
  { key: "interest:sleep", name: { "nl-BE": "Interesse: slaap", "fr-BE": "Intérêt : sommeil", en: "Interest: sleep" }, color: "#4f46e5", description: "Interested in sleep programmes." },
  { key: "interest:breathwork", name: { "nl-BE": "Interesse: ademwerk", "fr-BE": "Intérêt : respiration", en: "Interest: breathwork" }, color: "#0d9488", description: "Interested in breathwork sessions." },
  { key: "interest:events", name: { "nl-BE": "Interesse: events", "fr-BE": "Intérêt : événements", en: "Interest: events" }, color: "#be185d", description: "Interested in events and workshops." },
];

type T3 = Required<LocalizedText>;
export type DefaultPlaybookStage = {
  stageKey: string;
  name: T3;
  requiredAction: T3;
  ownerRole: string;
  deadlineDays: number;
  defaultProbabilityPct?: number;
  escalation?: PlaybookEscalationJson;
  kpi?: PlaybookKpiJson;
};

const esc = (afterDays: number): PlaybookEscalationJson => ({ after_days: afterDays, notify_role: "management", create_task: true });

/** The default B2B playbook (blueprint 29), one row per `opportunities_stage` value in board order. */
export const DEFAULT_B2B_PLAYBOOK: readonly DefaultPlaybookStage[] = [
  {
    stageKey: "target", ownerRole: "sales", deadlineDays: 7, defaultProbabilityPct: 5, escalation: esc(21),
    name: { "nl-BE": "Doelwit", "fr-BE": "Cible", en: "Target" },
    requiredAction: { "nl-BE": "Onderzoek het bedrijf en bepaal of het past", "fr-BE": "Analyser l'entreprise et vérifier son adéquation", en: "Research the company and check the fit" },
  },
  {
    stageKey: "prospect_identified", ownerRole: "sales", deadlineDays: 5, defaultProbabilityPct: 10, escalation: esc(14),
    name: { "nl-BE": "Prospect bepaald", "fr-BE": "Prospect identifié", en: "Prospect identified" },
    requiredAction: { "nl-BE": "Zoek de juiste contactpersoon", "fr-BE": "Trouver le bon interlocuteur", en: "Find the right contact person" },
  },
  {
    stageKey: "contact_identified", ownerRole: "sales", deadlineDays: 3, defaultProbabilityPct: 15, escalation: esc(10),
    name: { "nl-BE": "Contact bepaald", "fr-BE": "Contact identifié", en: "Contact identified" },
    requiredAction: { "nl-BE": "Neem een eerste keer contact op", "fr-BE": "Prendre un premier contact", en: "Make the first contact" },
  },
  {
    stageKey: "outreach", ownerRole: "sales", deadlineDays: 7, defaultProbabilityPct: 20, escalation: esc(14),
    name: { "nl-BE": "Benadering", "fr-BE": "Prise de contact", en: "Outreach" },
    requiredAction: { "nl-BE": "Volg het eerste bericht op", "fr-BE": "Relancer le premier message", en: "Follow up on the first message" },
  },
  {
    stageKey: "response", ownerRole: "sales", deadlineDays: 2, defaultProbabilityPct: 30, escalation: esc(7),
    name: { "nl-BE": "Reactie", "fr-BE": "Réponse", en: "Response" },
    requiredAction: { "nl-BE": "Plan een kennismakingsgesprek", "fr-BE": "Planifier un entretien de découverte", en: "Schedule an introductory call" },
  },
  {
    stageKey: "qualified", ownerRole: "sales", deadlineDays: 5, defaultProbabilityPct: 40, escalation: esc(10),
    name: { "nl-BE": "Gekwalificeerd", "fr-BE": "Qualifié", en: "Qualified" },
    requiredAction: { "nl-BE": "Bevestig budget, behoefte en beslisser", "fr-BE": "Confirmer le budget, le besoin et le décideur", en: "Confirm budget, need and decision maker" },
  },
  {
    stageKey: "discovery", ownerRole: "sales", deadlineDays: 7, defaultProbabilityPct: 50, escalation: esc(14),
    name: { "nl-BE": "Verkenning", "fr-BE": "Découverte", en: "Discovery" },
    requiredAction: { "nl-BE": "Houd een verkenningsgesprek of rondleiding", "fr-BE": "Mener l'entretien de découverte ou la visite", en: "Hold the discovery meeting or site visit" },
  },
  {
    stageKey: "proposal", ownerRole: "sales", deadlineDays: 5, defaultProbabilityPct: 60, escalation: esc(10),
    name: { "nl-BE": "Voorstel", "fr-BE": "Proposition", en: "Proposal" },
    requiredAction: { "nl-BE": "Stuur het voorstel en plan de opvolging", "fr-BE": "Envoyer la proposition et planifier le suivi", en: "Send the proposal and schedule the follow-up" },
    kpi: { name: { "nl-BE": "Voorstellen per maand", "fr-BE": "Propositions par mois", en: "Proposals per month" }, target: 4, unit: "count" },
  },
  {
    stageKey: "negotiation", ownerRole: "sales", deadlineDays: 7, defaultProbabilityPct: 80, escalation: esc(14),
    name: { "nl-BE": "Onderhandeling", "fr-BE": "Négociation", en: "Negotiation" },
    requiredAction: { "nl-BE": "Rond de voorwaarden af en vraag de handtekening", "fr-BE": "Finaliser les conditions et obtenir la signature", en: "Settle the terms and ask for the signature" },
  },
  {
    stageKey: "won", ownerRole: "sales", deadlineDays: 3, defaultProbabilityPct: 100,
    name: { "nl-BE": "Gewonnen", "fr-BE": "Gagné", en: "Won" },
    requiredAction: { "nl-BE": "Draag de klant over aan accountbeheer", "fr-BE": "Transmettre le client à la gestion de compte", en: "Hand the customer over to account management" },
    kpi: { name: { "nl-BE": "Gewonnen deals", "fr-BE": "Affaires gagnées", en: "Deals won" }, target: 2, unit: "count" },
  },
  {
    stageKey: "lost", ownerRole: "sales", deadlineDays: 90, defaultProbabilityPct: 0,
    name: { "nl-BE": "Verloren", "fr-BE": "Perdu", en: "Lost" },
    requiredAction: { "nl-BE": "Bekijk of het bedrijf opnieuw benaderd kan worden", "fr-BE": "Vérifier si l'entreprise peut être recontactée", en: "Check whether the company can be approached again" },
  },
  {
    stageKey: "account_management", ownerRole: "sales", deadlineDays: 30, defaultProbabilityPct: 100,
    name: { "nl-BE": "Accountbeheer", "fr-BE": "Gestion de compte", en: "Account management" },
    requiredAction: { "nl-BE": "Plan een evaluatiegesprek met de klant", "fr-BE": "Planifier un bilan avec le client", en: "Schedule a review meeting with the customer" },
  },
  {
    stageKey: "renewal", ownerRole: "sales", deadlineDays: 14, defaultProbabilityPct: 70, escalation: esc(21),
    name: { "nl-BE": "Verlenging", "fr-BE": "Renouvellement", en: "Renewal" },
    requiredAction: { "nl-BE": "Bespreek de verlenging van het contract", "fr-BE": "Discuter du renouvellement du contrat", en: "Discuss the contract renewal" },
  },
];

/** The default B2C playbook, one row per ops `person_stats.b2c_stage` value in pipeline order. */
export const DEFAULT_B2C_PLAYBOOK: readonly DefaultPlaybookStage[] = [
  {
    stageKey: "lead", ownerRole: "customer_service", deadlineDays: 2, escalation: esc(5),
    name: { "nl-BE": "Lead", "fr-BE": "Prospect", en: "Lead" },
    requiredAction: { "nl-BE": "Heet de nieuwe lead welkom en beantwoord vragen", "fr-BE": "Accueillir le nouveau prospect et répondre à ses questions", en: "Welcome the new lead and answer questions" },
  },
  {
    stageKey: "engaged_lead", ownerRole: "customer_service", deadlineDays: 3, escalation: esc(7),
    name: { "nl-BE": "Betrokken lead", "fr-BE": "Prospect engagé", en: "Engaged lead" },
    requiredAction: { "nl-BE": "Nodig uit voor een eerste bezoek", "fr-BE": "Inviter à une première visite", en: "Invite them to a first visit" },
  },
  {
    stageKey: "experienced", ownerRole: "customer_service", deadlineDays: 3,
    name: { "nl-BE": "Ervaren", "fr-BE": "Expérimenté", en: "Experienced" },
    requiredAction: { "nl-BE": "Vraag naar de ervaring en stel een pakket voor", "fr-BE": "Demander son ressenti et proposer un forfait", en: "Ask about the experience and suggest a package" },
  },
  {
    stageKey: "first_visit", ownerRole: "reception", deadlineDays: 2,
    name: { "nl-BE": "Eerste bezoek", "fr-BE": "Première visite", en: "First visit" },
    requiredAction: { "nl-BE": "Bel na het eerste bezoek voor feedback", "fr-BE": "Appeler après la première visite pour un retour", en: "Call after the first visit for feedback" },
  },
  {
    stageKey: "first_purchase", ownerRole: "customer_service", deadlineDays: 7,
    name: { "nl-BE": "Eerste aankoop", "fr-BE": "Premier achat", en: "First purchase" },
    requiredAction: { "nl-BE": "Help bij het plannen van de volgende sessies", "fr-BE": "Aider à planifier les prochaines séances", en: "Help plan the next sessions" },
  },
  {
    stageKey: "active", ownerRole: "customer_service", deadlineDays: 14,
    name: { "nl-BE": "Actief", "fr-BE": "Actif", en: "Active" },
    requiredAction: { "nl-BE": "Controleer of de klant tevreden is", "fr-BE": "Vérifier la satisfaction du client", en: "Check that the customer is satisfied" },
  },
  {
    stageKey: "repeat", ownerRole: "sales", deadlineDays: 14,
    name: { "nl-BE": "Terugkerend", "fr-BE": "Fidèle", en: "Repeat" },
    requiredAction: { "nl-BE": "Stel een lidmaatschap voor", "fr-BE": "Proposer un abonnement", en: "Suggest a membership" },
    kpi: { name: { "nl-BE": "Omzetting naar lid", "fr-BE": "Conversion en membre", en: "Conversion to member" }, target: 20, unit: "pct" },
  },
  {
    stageKey: "member", ownerRole: "customer_service", deadlineDays: 30,
    name: { "nl-BE": "Lid", "fr-BE": "Membre", en: "Member" },
    requiredAction: { "nl-BE": "Verwelkom het nieuwe lid persoonlijk", "fr-BE": "Accueillir personnellement le nouveau membre", en: "Welcome the new member personally" },
  },
  {
    stageKey: "retention", ownerRole: "customer_service", deadlineDays: 5, escalation: esc(10),
    name: { "nl-BE": "Behoud", "fr-BE": "Fidélisation", en: "Retention" },
    requiredAction: { "nl-BE": "Neem contact op om de klant terug te winnen", "fr-BE": "Contacter le client pour le faire revenir", en: "Contact the customer to win them back" },
  },
  {
    stageKey: "lost", ownerRole: "marketing", deadlineDays: 30,
    name: { "nl-BE": "Verloren", "fr-BE": "Perdu", en: "Lost" },
    requiredAction: { "nl-BE": "Bekijk of een heractivatie zinvol is", "fr-BE": "Évaluer si une réactivation a du sens", en: "Decide whether a reactivation makes sense" },
  },
];

/** Every default playbook row (`sort_order` in steps of 10, so staff can insert between). */
export function defaultPlaybookRows(): (typeof playbookStages.$inferInsert)[] {
  const rows = (pipeline: "b2b" | "b2c", list: readonly DefaultPlaybookStage[]) =>
    list.map((p, i) => ({
      pipeline,
      stageKey: p.stageKey,
      sortOrder: (i + 1) * 10,
      name: p.name,
      requiredAction: p.requiredAction,
      ownerRole: p.ownerRole,
      deadlineDays: p.deadlineDays,
      defaultProbabilityPct: pipeline === "b2b" ? (p.defaultProbabilityPct ?? null) : null,
      escalation: p.escalation ?? {},
      kpi: p.kpi ?? {},
    }));
  return [...rows("b2b", DEFAULT_B2B_PLAYBOOK), ...rows("b2c", DEFAULT_B2C_PLAYBOOK)];
}

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
  await db
    .insert(playbookStages)
    .values(defaultPlaybookRows())
    .onConflictDoNothing({ target: [playbookStages.pipeline, playbookStages.stageKey] });
}

export const seed: DefaultSeed = { after: ["platform"], run };
