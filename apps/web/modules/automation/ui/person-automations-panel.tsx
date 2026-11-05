/**
 * `PersonAutomationsPanel` (automation spec 5, A-36 to A-41): the server component crm renders in
 * the "Automations" tab of `/admin/persons/[id]` (`persons.read`). Active journeys with their
 * next step and due time, a "Preview next steps" drawer per journey (A-39, computed read-only by
 * `previewSteps`), per-journey Exit, the "Enrol in..." and "Move to..." dialogs (hidden without
 * `automations.move_person`), ended journeys with their end reason and the automation timeline
 * with outcome filters. Times in Europe/Brussels. Empty: "This person is in no journey".
 *
 * Labels come from the `automation` catalogue; the keys this package adds (`panel.enrol`,
 * `panel.warning.*`, `errors.anchor_required`, ...) are not in the catalogue yet (automation-P5
 * owns it), so `PANEL_FALLBACK` holds their three-language text until the catalogue has them;
 * a catalogue value always wins.
 */
import type { ReactNode } from "react";
import type { DbOrTx } from "@beam/db";
import { formatDateTime, type Locale } from "@beam/core/i18n";
import { getAppDb } from "@/lib/ctx";
import { previewSteps, type PreviewStep } from "../engine/preview";
import { automationLabels, getPersonAutomations, listEnrolOptions, type PersonEnrolmentView } from "../queries";
import { AutomationTimeline, type TimelineRow } from "./automation-timeline";
import { EnrolDialog, type EnrolChoice } from "./enrol-dialog";
import { ExitEnrolmentButton, MoveDialog } from "./move-dialog";
import { fill, type Labels } from "./outcome-badge";
import { PreviewDrawer, type PreviewRow } from "./preview-drawer";

export type PersonAutomationsPanelProps = {
  personId: string;
  /** Defaults to the app database (tests pass theirs). */
  db?: DbOrTx;
  /** Defaults to the signed-in staff user's locale. */
  locale?: Locale;
  /** Shows Exit, Enrol and Move; defaults to the signed-in user's `automations.move_person`. */
  canMove?: boolean;
  /** The preview's clock (tests); defaults to now. */
  now?: Date;
};

type Text = { en: string; "nl-BE": string; "fr-BE": string };

/** Three-language text of the panel keys missing from the catalogue (see the header). */
export const PANEL_FALLBACK: Record<string, Text> = {
  "panel.enrol": { en: "Enrol in…", "nl-BE": "Inschrijven in…", "fr-BE": "Inscrire dans…" },
  "panel.enrol_title": { en: "Enrol in a journey", "nl-BE": "Inschrijven in een traject", "fr-BE": "Inscrire dans un parcours" },
  "panel.enrol_body": {
    en: "Re-entry, audience and priority rules are overridden. Consent never is: marketing emails to a person who is not reachable are skipped.",
    "nl-BE": "Regels voor herinschrijving, doelgroep en prioriteit worden overschreven. Toestemming nooit: marketingmails naar iemand die niet bereikbaar is, worden overgeslagen.",
    "fr-BE": "Les règles de réinscription, de public et de priorité sont ignorées. Le consentement jamais : les e-mails marketing vers une personne non joignable ne sont pas envoyés.",
  },
  "panel.automation": { en: "Automation", "nl-BE": "Automatisering", "fr-BE": "Automatisation" },
  "panel.anchor": { en: "Anchor date and time", "nl-BE": "Ankerdatum en -tijd", "fr-BE": "Date et heure d'ancrage" },
  "panel.anchor_hint": {
    en: "The steps are planned from this moment (Europe/Brussels).",
    "nl-BE": "De stappen worden vanaf dit moment gepland (Europe/Brussels).",
    "fr-BE": "Les étapes sont planifiées à partir de ce moment (Europe/Brussels).",
  },
  "panel.enrol_submit": { en: "Enrol", "nl-BE": "Inschrijven", "fr-BE": "Inscrire" },
  "panel.no_options": { en: "There is no active automation.", "nl-BE": "Er is geen actieve automatisering.", "fr-BE": "Il n'y a aucune automatisation active." },
  "panel.move": { en: "Move to…", "nl-BE": "Verplaatsen naar…", "fr-BE": "Déplacer vers…" },
  "panel.move_title": { en: "Move to another journey", "nl-BE": "Naar een ander traject verplaatsen", "fr-BE": "Déplacer vers un autre parcours" },
  "panel.move_body": {
    en: "The current journey ends now and the new one starts in the same step.",
    "nl-BE": "Het huidige traject stopt nu en het nieuwe start in dezelfde stap.",
    "fr-BE": "Le parcours actuel se termine maintenant et le nouveau commence dans la même opération.",
  },
  "panel.from": { en: "From", "nl-BE": "Van", "fr-BE": "De" },
  "panel.to": { en: "To", "nl-BE": "Naar", "fr-BE": "Vers" },
  "panel.move_submit": { en: "Move", "nl-BE": "Verplaatsen", "fr-BE": "Déplacer" },
  "panel.exit": { en: "Exit", "nl-BE": "Stoppen", "fr-BE": "Arrêter" },
  "panel.exit_title": { en: "Stop {name}?", "nl-BE": "{name} stoppen?", "fr-BE": "Arrêter {name} ?" },
  "panel.exit_body": {
    en: "The journey ends now. Planned steps are not sent.",
    "nl-BE": "Het traject stopt nu. Geplande stappen worden niet verstuurd.",
    "fr-BE": "Le parcours se termine maintenant. Les étapes prévues ne sont pas envoyées.",
  },
  "panel.note": { en: "Note (optional)", "nl-BE": "Notitie (optioneel)", "fr-BE": "Note (facultatif)" },
  "panel.exit_submit": { en: "Stop journey", "nl-BE": "Traject stoppen", "fr-BE": "Arrêter le parcours" },
  "panel.preview": { en: "Preview next steps", "nl-BE": "Volgende stappen bekijken", "fr-BE": "Aperçu des prochaines étapes" },
  "panel.preview_title": { en: "Next steps", "nl-BE": "Volgende stappen", "fr-BE": "Prochaines étapes" },
  "panel.preview_empty": { en: "No step is left.", "nl-BE": "Er is geen stap meer.", "fr-BE": "Il ne reste aucune étape." },
  "panel.col_step": { en: "Step", "nl-BE": "Stap", "fr-BE": "Étape" },
  "panel.col_due": { en: "Due", "nl-BE": "Gepland", "fr-BE": "Prévu" },
  "panel.col_outcome": { en: "Expected outcome", "nl-BE": "Verwacht resultaat", "fr-BE": "Résultat attendu" },
  "panel.entered": { en: "Started {date}", "nl-BE": "Gestart op {date}", "fr-BE": "Commencé le {date}" },
  "panel.warning.audience": {
    en: "This person is outside the journey's audience. Staff may still enrol them.",
    "nl-BE": "Deze persoon valt buiten de doelgroep van het traject. Een medewerker mag toch inschrijven.",
    "fr-BE": "Cette personne est hors du public du parcours. L'équipe peut quand même l'inscrire.",
  },
  "panel.warning.unreachable": {
    en: "This person is not reachable for this purpose: every marketing email of the journey will be skipped.",
    "nl-BE": "Deze persoon is niet bereikbaar voor dit doel: elke marketingmail van het traject wordt overgeslagen.",
    "fr-BE": "Cette personne n'est pas joignable pour cette finalité : aucun e-mail marketing du parcours ne sera envoyé.",
  },
  "panel.warning.already_active": { en: "This person is already in this journey.", "nl-BE": "Deze persoon zit al in dit traject.", "fr-BE": "Cette personne est déjà dans ce parcours." },
  "panel.warning.exclusive": {
    en: "Another journey of the same group is active; it ends when this one starts.",
    "nl-BE": "Een ander traject van dezelfde groep loopt; dat stopt wanneer dit start.",
    "fr-BE": "Un autre parcours du même groupe est actif ; il se termine quand celui-ci commence.",
  },
  "panel.warning.restricted": {
    en: "Processing is restricted for this person: a marketing journey refuses the entry.",
    "nl-BE": "De verwerking is beperkt voor deze persoon: een marketingtraject weigert de inschrijving.",
    "fr-BE": "Le traitement est limité pour cette personne : un parcours marketing refuse l'inscription.",
  },
  "panel.refused.generic": { en: "The person was not enrolled.", "nl-BE": "De persoon werd niet ingeschreven.", "fr-BE": "La personne n'a pas été inscrite." },
  "panel.refused.re_entry": { en: "The person is already in this journey.", "nl-BE": "De persoon zit al in dit traject.", "fr-BE": "La personne est déjà dans ce parcours." },
  "panel.refused.skipped_unreachable": {
    en: "Not enrolled: processing is restricted for this person.",
    "nl-BE": "Niet ingeschreven: de verwerking is beperkt voor deze persoon.",
    "fr-BE": "Pas inscrite : le traitement est limité pour cette personne.",
  },
  "panel.refused.audience": {
    en: "Not enrolled: this person was erased or merged.",
    "nl-BE": "Niet ingeschreven: deze persoon werd gewist of samengevoegd.",
    "fr-BE": "Pas inscrite : cette personne a été effacée ou fusionnée.",
  },
  "panel.refused.inactive": { en: "Not enrolled: the automation is not active.", "nl-BE": "Niet ingeschreven: de automatisering is niet actief.", "fr-BE": "Pas inscrite : l'automatisation n'est pas active." },
  "panel.refused.anchor_missing": { en: "Not enrolled: enter the anchor date.", "nl-BE": "Niet ingeschreven: vul de ankerdatum in.", "fr-BE": "Pas inscrite : indiquez la date d'ancrage." },
  "panel.filter_label": { en: "Filter by outcome", "nl-BE": "Filteren op resultaat", "fr-BE": "Filtrer par résultat" },
  "panel.filter.all": { en: "All", "nl-BE": "Alle", "fr-BE": "Tous" },
  "panel.filter.done": { en: "Done", "nl-BE": "Uitgevoerd", "fr-BE": "Effectués" },
  "panel.filter.info": { en: "Journey", "nl-BE": "Traject", "fr-BE": "Parcours" },
  "panel.filter.skipped": { en: "Skipped", "nl-BE": "Overgeslagen", "fr-BE": "Ignorés" },
  "panel.filter.failed": { en: "Failed", "nl-BE": "Mislukt", "fr-BE": "Échecs" },
  "panel.timeline_empty": { en: "No automation activity yet.", "nl-BE": "Nog geen automatiseringsactiviteit.", "fr-BE": "Pas encore d'activité d'automatisation." },
  "panel.email_status": { en: "Email", "nl-BE": "E-mail", "fr-BE": "E-mail" },
  "preview.failed": { en: "Fails: template unavailable", "nl-BE": "Mislukt: sjabloon niet beschikbaar", "fr-BE": "Échec : modèle indisponible" },
  "errors.enrolment_not_active": { en: "This journey has already ended.", "nl-BE": "Dit traject is al gestopt.", "fr-BE": "Ce parcours est déjà terminé." },
  "errors.enrolment_not_found": { en: "This enrolment no longer exists.", "nl-BE": "Deze inschrijving bestaat niet meer.", "fr-BE": "Cette inscription n'existe plus." },
  "errors.person_not_found": { en: "This person no longer exists.", "nl-BE": "Deze persoon bestaat niet meer.", "fr-BE": "Cette personne n'existe plus." },
  "errors.anchor_required": { en: "Enter the anchor date and time.", "nl-BE": "Vul de ankerdatum en -tijd in.", "fr-BE": "Indiquez la date et l'heure d'ancrage." },
  "errors.move_same_automation": {
    en: "Choose another automation than the current one.",
    "nl-BE": "Kies een andere automatisering dan de huidige.",
    "fr-BE": "Choisissez une autre automatisation que l'actuelle.",
  },
  "errors.move_refused": {
    en: "The move was refused; the person stays in the current journey.",
    "nl-BE": "De verplaatsing werd geweigerd; de persoon blijft in het huidige traject.",
    "fr-BE": "Le déplacement a été refusé ; la personne reste dans le parcours actuel.",
  },
};

const PREFIXES = ["panel", "outcome", "end_reason", "preview", "errors", "common", "source"] as const;

/** The panel's labels: the catalogue first, then `PANEL_FALLBACK` for the keys it lacks. */
export function panelLabels(locale: Locale): Labels {
  const fallback = Object.fromEntries(Object.entries(PANEL_FALLBACK).map(([k, v]) => [k, v[locale]]));
  return { ...fallback, ...automationLabels(locale, PREFIXES) };
}

/** `automations.move_person` of the signed-in user; false outside a request (tests, jobs). */
async function signedInCanMove(): Promise<boolean> {
  try {
    const { actorFromSession, getSession, hasPermission } = await import("@/lib/auth");
    const actor = actorFromSession(await getSession());
    return !!actor && actor.kind === "staff" && hasPermission(actor, "automations.move_person");
  } catch {
    return false;
  }
}

/** An end reason in words: `exit_event:order.paid` -> "Exit event: order.paid". */
function endReasonText(l: Labels, reason: string | null): string | null {
  if (!reason) return null;
  const [head, ...rest] = reason.split(":");
  const words = l[`end_reason.${head}`] ?? head!;
  return rest.length ? `${words}: ${rest.join(":")}` : words;
}

export async function PersonAutomationsPanel(props: PersonAutomationsPanelProps) {
  const db = props.db ?? (await getAppDb());
  const locale = props.locale ?? (await (await import("@/lib/i18n")).adminLocale());
  const canMove = props.canMove ?? (await signedInCanMove());
  const now = props.now ?? new Date();
  const l = panelLabels(locale);
  const when = (d: Date | null) => (d ? formatDateTime(d, locale) : "");

  const data = await getPersonAutomations(db, { personId: props.personId });
  const options: EnrolChoice[] = canMove
    ? (await listEnrolOptions(db, { personId: props.personId })).map((o) => ({ id: o.id, name: o.name, needsAnchor: o.needsAnchor, warnings: o.warnings }))
    : [];
  const previews = new Map<string, PreviewRow[]>();
  for (const e of data.active) {
    let steps: PreviewStep[];
    try {
      steps = await previewSteps(db, { personId: props.personId, automationId: e.automationId, now });
    } catch {
      steps = [];
    }
    previews.set(
      e.enrolmentId,
      steps.map((s) => ({ key: s.key, type: s.type, due: when(s.dueAt), outcome: s.outcome, reason: s.reason })),
    );
  }

  const controls = canMove ? (
    <div className="flex flex-wrap gap-2" data-testid="automation-panel-controls">
      <EnrolDialog personId={props.personId} options={options} labels={l} />
      <MoveDialog
        personId={props.personId}
        sources={data.active.map((e) => ({ enrolmentId: e.enrolmentId, automationId: e.automationId, name: e.automationName }))}
        targets={options}
        labels={l}
      />
    </div>
  ) : null;

  if (!data.active.length && !data.ended.length && !data.runs.length) {
    return (
      <div className="grid gap-3" data-testid="automation-panel">
        <p data-testid="automation-panel-empty" className="text-sm text-muted-foreground">
          {l["panel.empty"]}
        </p>
        {controls}
      </div>
    );
  }

  const section = (key: string, body: ReactNode) => (
    <section aria-labelledby={`automation-panel-${key}-h`} data-testid={`automation-panel-${key}`} className="grid gap-2">
      <h3 id={`automation-panel-${key}-h`} className="font-semibold">
        {l[`panel.${key}`]}
      </h3>
      {body}
    </section>
  );
  const activeItem = (e: PersonEnrolmentView) => (
    <li key={e.enrolmentId} data-enrolment-id={e.enrolmentId} data-automation={e.automationSlug} className="grid gap-1 rounded-md border p-2">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <strong>{e.automationName}</strong>
        <small className="text-muted-foreground">
          {fill(l["panel.entered"], { date: when(e.enteredAt) })} · {l[`source.${e.source}`] ?? e.source}
        </small>
      </div>
      {e.nextStepKey ? (
        <span data-testid="automation-next-step" className="text-sm">
          {l["panel.next_step"]}: <span className="font-mono">{e.nextStepKey}</span>, {when(e.nextStepAt)}
        </span>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <PreviewDrawer enrolmentId={e.enrolmentId} automationName={e.automationName} rows={previews.get(e.enrolmentId) ?? []} labels={l} />
        {canMove ? <ExitEnrolmentButton enrolmentId={e.enrolmentId} automationName={e.automationName} labels={l} /> : null}
      </div>
    </li>
  );
  const endedItem = (e: PersonEnrolmentView) => (
    <li key={e.enrolmentId} data-enrolment-id={e.enrolmentId} data-automation={e.automationSlug} data-end-reason={e.endReason ?? ""}>
      <strong>{e.automationName}</strong> <span>{endReasonText(l, e.endReason) ?? l[`end_reason.${e.status}`]}</span>,{" "}
      <small className="text-muted-foreground">{when(e.endedAt)}</small>
    </li>
  );
  const rows: TimelineRow[] = data.runs.map((t) => ({
    id: t.id,
    time: when(t.occurredAt),
    iso: t.occurredAt.toISOString(),
    automationName: t.automationName,
    stepKey: t.stepKey,
    outcome: t.outcome,
    detail: t.outcome === "exited" ? (endReasonText(l, t.endReason ?? t.reason) ?? t.reason) : t.reason,
    emailStatus: t.emailStatus,
  }));

  return (
    <div className="grid gap-4" data-testid="automation-panel">
      {controls}
      {section(
        "active",
        data.active.length ? <ul className="grid gap-2">{data.active.map(activeItem)}</ul> : <p className="text-sm text-muted-foreground">{l["panel.no_active"]}</p>,
      )}
      {data.ended.length ? section("ended", <ul className="grid gap-1 text-sm">{data.ended.map(endedItem)}</ul>) : null}
      {section("timeline", <AutomationTimeline rows={rows} labels={l} />)}
    </div>
  );
}
