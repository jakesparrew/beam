/**
 * `PersonAutomationsPanel` (automation spec 5, A-36 to A-41): the server component crm renders in
 * the "Automations" tab of `/admin/persons/[id]` (`persons.read`). Active journeys with their
 * next step and due time, a "Preview next steps" drawer per journey (A-39, computed read-only by
 * `previewSteps`), per-journey Exit, the "Enrol in..." and "Move to..." dialogs (hidden without
 * `automations.move_person`), ended journeys with their end reason and the automation timeline
 * with outcome filters. Times in Europe/Brussels. Empty: "This person is in no journey".
 *
 * Labels come from the `automation` catalogue (`panel.*`, `outcome.*`, `end_reason.*`,
 * `preview.*`, `errors.*`, `common.*`, `source.*`) in all three languages.
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

const PREFIXES = ["panel", "outcome", "end_reason", "preview", "errors", "common", "source"] as const;

/** The panel's labels, from the catalogue. */
export function panelLabels(locale: Locale): Labels {
  return automationLabels(locale, PREFIXES);
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
