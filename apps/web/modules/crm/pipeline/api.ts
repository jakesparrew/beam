/**
 * B2B pipeline and sales playbook rules (crm rules 3.46 to 3.48 and 3.56), crm-P8. The staff
 * actions in `./actions` and the jobs in `./jobs` call these handlers, kept here so the rules
 * are testable with a plain `Ctx`.
 *
 * - Stage transitions (rule 3.47): any open stage (`target` … `negotiation`) moves to any other
 *   open stage, `won` or `lost`; `won → account_management → renewal`; `renewal → won` or
 *   `lost`; `lost → target` reopens. Everything else is `conflict`. A move locks the row
 *   `FOR UPDATE` and checks `version`.
 * - Entering a stage (rule 3.46) creates one task for the opportunity owner from the active
 *   playbook stage (dedupe `playbook:<opportunity_id>:<stage>:<stage_entered_at minute>`) and
 *   enrols the primary contact when the stage names an `automation_slug`.
 * - Probability: `won` 100, `lost` 0; any other stage applies its `default_probability_pct`
 *   unless staff set the probability by hand on the stage being left
 *   (`probability_set_manually_at >= stage_entered_at`).
 */
import type { DbOrTx, Tx } from "@beam/db";
import { companies, OPPORTUNITY_STAGES, opportunities, persons, playbookStages, ROLE_KEYS, tasks, users, type OpportunityStage, type PlaybookPipeline, type RoleKey } from "@beam/db/schema";
import { LOCALES, missingLocales, type Locale, type LocalizedText } from "@beam/core/i18n";
import { and, ConflictError, eq, NotFoundError, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { enrolPersonBySlug } from "@/modules/automation/api";
import type { EventCtx } from "../api";
import { resolveCanonicalPersonId } from "../persons/api";
import { createTask } from "../tasks/api";

export { OPPORTUNITY_STAGES, type OpportunityStage };

export const OPEN_STAGES = ["target", "prospect_identified", "contact_identified", "outreach", "response", "qualified", "discovery", "proposal", "negotiation"] as const satisfies readonly OpportunityStage[];
/** Board columns: the open stages, then the after-sale stages; `won` and `lost` leave the board. */
export const BOARD_STAGES = [...OPEN_STAGES, "account_management", "renewal"] as const satisfies readonly OpportunityStage[];
/** ops' `person_stats.b2c_stage` values (the keys of the B2C playbook). */
export const B2C_STAGE_KEYS = ["lead", "engaged_lead", "experienced", "first_visit", "first_purchase", "active", "repeat", "member", "retention", "lost"] as const;

const DAY_MS = 86_400_000;
const isOpen = (s: OpportunityStage) => (OPEN_STAGES as readonly string[]).includes(s);

/** Rule 3.47: whether `from → to` is allowed (a move to the same stage is not a move). */
export function canMoveStage(from: OpportunityStage, to: OpportunityStage): boolean {
  if (from === to) return false;
  if (isOpen(from)) return isOpen(to) || to === "won" || to === "lost";
  switch (from) {
    case "won":
      return to === "account_management";
    case "account_management":
      return to === "renewal";
    case "renewal":
      return to === "won" || to === "lost";
    case "lost":
      return to === "target";
    default:
      return false;
  }
}

/** `YYYY-MM-DDTHH:mm` (UTC) of a stored time, the bucket of `playbook:` and `escalate:` keys (DM-5). */
export const minuteBucket = (at: Date): string => at.toISOString().slice(0, 16);

export const playbookTaskKey = (opportunityId: string, stage: string, stageEnteredAt: Date) => `playbook:${opportunityId}:${stage}:${minuteBucket(stageEnteredAt)}`;
export const escalationKey = (opportunityId: string, stage: string, stageEnteredAt: Date) => `escalate:${opportunityId}:${stage}:${minuteBucket(stageEnteredAt)}`;
export const btocTaskKey = (personId: string, stage: string, eventId: string) => `playbook:b2c:${personId}:${stage}:${eventId}`;

export type PlaybookStageRecord = typeof playbookStages.$inferSelect;
type OpportunityRecord = typeof opportunities.$inferSelect;

export const asRoleKey = (v: string | null | undefined): RoleKey | undefined => ((ROLE_KEYS as readonly string[]).includes(v ?? "") ? (v as RoleKey) : undefined);

/** The active playbook stage of `pipeline` and `stageKey`, or `null`. */
export async function activePlaybookStage(tx: DbOrTx, pipeline: PlaybookPipeline, stageKey: string): Promise<PlaybookStageRecord | null> {
  const [row] = await tx
    .select()
    .from(playbookStages)
    .where(and(eq(playbookStages.pipeline, pipeline), eq(playbookStages.stageKey, stageKey), eq(playbookStages.isActive, true)));
  return row ?? null;
}

/** The user's interface language (a playbook task title is written in it). */
export async function userLocale(tx: DbOrTx, userId: string): Promise<Locale> {
  const [row] = await tx.select({ locale: users.locale }).from(users).where(eq(users.id, userId));
  return row?.locale ?? "nl-BE";
}

/** A task title from a LocalizedText in `locale` (every playbook text is complete, `savePlaybookStage`). */
export function titleFrom(text: LocalizedText, locale: Locale): string {
  const value = text[locale]?.trim() || LOCALES.map((l) => text[l]?.trim()).find(Boolean) || "—";
  return value.slice(0, 200);
}

/**
 * Rule 3.46: what entering `opp.stage` causes. One task for the opportunity owner from the
 * active playbook stage (repeat calls return the same task) and the enrolment of the primary
 * contact when the stage has an `automation_slug`. An inactive or missing stage does nothing.
 */
export async function enterStage(tx: Tx, ctx: EventCtx, opp: OpportunityRecord): Promise<{ taskId: string | null; created: boolean; enrolled: boolean }> {
  const stage = await activePlaybookStage(tx, "b2b", opp.stage);
  if (!stage) return { taskId: null, created: false, enrolled: false };
  const locale = await userLocale(tx, opp.ownerUserId);
  const task = await createTask(tx, ctx, {
    title: titleFrom(stage.requiredAction, locale),
    kind: "follow_up",
    ownerUserId: opp.ownerUserId,
    dueAt: new Date(opp.stageEnteredAt.getTime() + stage.deadlineDays * DAY_MS),
    companyId: opp.companyId,
    source: "system",
    ref: { type: "opportunity", id: opp.id },
    dedupeKey: playbookTaskKey(opp.id, opp.stage, opp.stageEnteredAt),
  });
  if (task.created) await tx.update(tasks).set({ opportunityId: opp.id }).where(eq(tasks.id, task.taskId));
  let enrolled = false;
  const slug = stage.automatedCommunication.automation_slug?.trim();
  if (task.created && slug && opp.primaryContactPersonId) {
    const result = await enrolPersonBySlug(tx, { slug, personId: opp.primaryContactPersonId });
    enrolled = result.status === "enrolled";
  }
  return { taskId: task.taskId, created: task.created, enrolled };
}

// ---------------------------------------------------------------------------
// saveOpportunity (crm.save_opportunity, audit opportunity.save)
// ---------------------------------------------------------------------------

export type SaveOpportunityInput = {
  id?: string;
  companyId: string;
  title: string;
  primaryContactPersonId?: string | null;
  valueCents: number;
  probabilityPct?: number;
  expectedCloseOn?: string | null;
  ownerUserId: string;
  nextAction?: string | null;
  nextActionAt?: Date | null;
  notes?: string | null;
  source?: string | null;
  version?: number;
};

const auditView = (o: OpportunityRecord) => ({
  companyId: o.companyId,
  title: o.title,
  primaryContactPersonId: o.primaryContactPersonId,
  stage: o.stage,
  valueCents: o.valueCents,
  probabilityPct: o.probabilityPct,
  expectedCloseOn: o.expectedCloseOn,
  ownerUserId: o.ownerUserId,
  nextAction: o.nextAction,
  nextActionAt: o.nextActionAt?.toISOString() ?? null,
  lostReason: o.lostReason,
  source: o.source,
  notes: o.notes,
});

const blank = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);

async function companyExists(tx: DbOrTx, companyId: string): Promise<void> {
  const [row] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
  if (!row) throw new NotFoundError("company_not_found");
}

/** The primary contact: the merge winner of the given person; an erased person is refused. */
async function canonicalOpportunityContact(tx: DbOrTx, personId: string): Promise<string> {
  const id = await resolveCanonicalPersonId(tx, personId);
  const [row] = await tx.select({ erasedAt: persons.erasedAt }).from(persons).where(eq(persons.id, id));
  if (!row || row.erasedAt) throw new ValidationError("contact_invalid", { primaryContactPersonId: "invalid" });
  return id;
}

export async function saveStaffOpportunity(ctx: Ctx, input: SaveOpportunityInput): Promise<{ opportunityId: string; version: number }> {
  const tx = ctx.tx;
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new ValidationError("validation", { title: "required" });
  await companyExists(tx, input.companyId);
  const contactId = input.primaryContactPersonId ? await canonicalOpportunityContact(tx, input.primaryContactPersonId) : null;
  const values = {
    companyId: input.companyId,
    title,
    primaryContactPersonId: contactId,
    valueCents: input.valueCents,
    expectedCloseOn: input.expectedCloseOn || null,
    ownerUserId: input.ownerUserId,
    nextAction: blank(input.nextAction),
    nextActionAt: input.nextActionAt ?? null,
    notes: blank(input.notes),
    source: blank(input.source),
  };

  if (!input.id) {
    const stageDefault = (await activePlaybookStage(tx, "b2b", "target"))?.defaultProbabilityPct;
    const manual = input.probabilityPct !== undefined;
    const [row] = await tx
      .insert(opportunities)
      .values({
        ...values,
        stage: "target",
        stageEnteredAt: ctx.now,
        probabilityPct: input.probabilityPct ?? stageDefault ?? 10,
        probabilitySetManuallyAt: manual ? ctx.now : null,
      })
      .returning();
    const opp = row!;
    await ctx.recordEvent({
      kind: "opportunity.created",
      companyId: opp.companyId,
      ref: { type: "opportunity", id: opp.id },
      data: { opportunity_id: opp.id, to_stage: opp.stage, value_cents: opp.valueCents },
    });
    await ctx.audit({ action: "opportunity.save", entityType: "opportunities", entityId: opp.id, newValue: auditView(opp) });
    await enterStage(tx, ctx, opp);
    return { opportunityId: opp.id, version: opp.version };
  }

  const [before] = await tx.select().from(opportunities).where(eq(opportunities.id, input.id)).for("update");
  if (!before) throw new NotFoundError("opportunity_not_found");
  if (input.version !== undefined && input.version !== before.version) throw new ConflictError("stale_version");
  const probabilityChanged = input.probabilityPct !== undefined && input.probabilityPct !== before.probabilityPct;
  const [after] = await tx
    .update(opportunities)
    .set({
      ...values,
      ...(probabilityChanged ? { probabilityPct: input.probabilityPct, probabilitySetManuallyAt: ctx.now } : {}),
      version: before.version + 1,
      updatedAt: ctx.now,
    })
    .where(eq(opportunities.id, input.id))
    .returning();
  const oldView = auditView(before);
  const newView = auditView(after!);
  const fields = (Object.keys(newView) as (keyof typeof newView)[]).filter((k) => JSON.stringify(oldView[k]) !== JSON.stringify(newView[k]));
  if (fields.length) {
    await ctx.recordEvent({
      kind: "opportunity.updated",
      companyId: after!.companyId,
      ref: { type: "opportunity", id: after!.id },
      data: { opportunity_id: after!.id, value_cents: after!.valueCents, fields },
    });
  }
  await ctx.audit({ action: "opportunity.save", entityType: "opportunities", entityId: after!.id, oldValue: oldView, newValue: newView });
  return { opportunityId: after!.id, version: after!.version };
}

// ---------------------------------------------------------------------------
// moveOpportunityStage (crm.move_opportunity, audit opportunity.stage)
// ---------------------------------------------------------------------------

export type MoveStageInput = { id: string; stage: OpportunityStage; version: number; lostReason?: string };

export async function moveStaffOpportunity(ctx: Ctx, input: MoveStageInput): Promise<{ stage: OpportunityStage; version: number; probabilityPct: number; taskId: string | null }> {
  const tx = ctx.tx;
  const [before] = await tx.select().from(opportunities).where(eq(opportunities.id, input.id)).for("update");
  if (!before) throw new NotFoundError("opportunity_not_found");
  if (input.version !== before.version) throw new ConflictError("stale_version");
  if (!canMoveStage(before.stage, input.stage)) throw new ConflictError(before.stage === input.stage ? "same_stage" : "stage_transition_not_allowed");
  const lostReason = input.lostReason?.trim().slice(0, 500) ?? "";
  if (input.stage === "lost" && !lostReason) throw new ValidationError("lost_reason_required", { lostReason: "required" });

  const target = await activePlaybookStage(tx, "b2b", input.stage);
  const manualOnStage = !!before.probabilitySetManuallyAt && before.probabilitySetManuallyAt.getTime() >= before.stageEnteredAt.getTime();
  const probabilityPct =
    input.stage === "won" ? 100 : input.stage === "lost" ? 0 : !manualOnStage && target?.defaultProbabilityPct != null ? target.defaultProbabilityPct : before.probabilityPct;
  const reopened = before.stage === "lost";

  const [after] = await tx
    .update(opportunities)
    .set({
      stage: input.stage,
      stageEnteredAt: ctx.now,
      probabilityPct,
      ...(input.stage === "won" ? { wonAt: ctx.now } : {}),
      ...(input.stage === "lost" ? { lostAt: ctx.now, lostReason } : {}),
      ...(reopened ? { lostAt: null, lostReason: null } : {}),
      version: before.version + 1,
      updatedAt: ctx.now,
    })
    .where(eq(opportunities.id, input.id))
    .returning();
  const opp = after!;
  const data = { opportunity_id: opp.id, from_stage: before.stage, to_stage: opp.stage, value_cents: opp.valueCents };
  const base = { companyId: opp.companyId, ref: { type: "opportunity", id: opp.id } };
  await ctx.recordEvent({ kind: "opportunity.stage_changed", ...base, data });
  if (opp.stage === "won") await ctx.recordEvent({ kind: "opportunity.won", ...base, data });
  if (opp.stage === "lost") await ctx.recordEvent({ kind: "opportunity.lost", ...base, data: { ...data, reason: lostReason } });
  if (reopened) await ctx.recordEvent({ kind: "opportunity.reopened", ...base, data });
  await ctx.audit({
    action: "opportunity.stage",
    entityType: "opportunities",
    entityId: opp.id,
    oldValue: { stage: before.stage, probabilityPct: before.probabilityPct, lostReason: before.lostReason },
    newValue: { stage: opp.stage, probabilityPct: opp.probabilityPct, lostReason: opp.lostReason },
  });
  const entered = await enterStage(tx, ctx, opp);
  return { stage: opp.stage, version: opp.version, probabilityPct: opp.probabilityPct, taskId: entered.taskId };
}

// ---------------------------------------------------------------------------
// savePlaybookStage (crm.save_playbook_stage, settings.write, audit playbook.save)
// ---------------------------------------------------------------------------

export type SavePlaybookStageInput = {
  pipeline: PlaybookPipeline;
  stageKey: string;
  sortOrder: number;
  name: LocalizedText;
  requiredAction: LocalizedText;
  ownerRole: string;
  deadlineDays: number;
  defaultProbabilityPct?: number | null;
  automatedCommunication: { automation_slug?: string; template_slug?: string };
  humanCommunication?: LocalizedText | null;
  escalation: { after_days?: number; notify_role?: string; create_task?: boolean };
  kpi: { name?: LocalizedText; target?: number; unit?: "count" | "pct" | "cents" | "days" };
  isActive: boolean;
};

const hasText = (t: LocalizedText | null | undefined) => !!t && LOCALES.some((l) => !!t[l]?.trim());

export async function saveStaffPlaybookStage(ctx: Ctx, input: SavePlaybookStageInput): Promise<{ stageId: string }> {
  const keys: readonly string[] = input.pipeline === "b2b" ? OPPORTUNITY_STAGES : B2C_STAGE_KEYS;
  if (!keys.includes(input.stageKey)) throw new ValidationError("stage_key_invalid", { stageKey: "invalid" });
  if (!asRoleKey(input.ownerRole)) throw new ValidationError("role_invalid", { ownerRole: "invalid" });
  if (input.escalation.notify_role && !asRoleKey(input.escalation.notify_role)) throw new ValidationError("role_invalid", { "escalation.notify_role": "invalid" });
  if (input.pipeline === "b2c" && input.defaultProbabilityPct != null) throw new ValidationError("probability_b2b_only", { defaultProbabilityPct: "b2b_only" });
  const complete: [string, LocalizedText | null | undefined][] = [
    ["name", input.name],
    ["requiredAction", input.requiredAction],
    ...(hasText(input.humanCommunication) ? ([["humanCommunication", input.humanCommunication]] as [string, LocalizedText][]) : []),
    ...(hasText(input.kpi.name) ? ([["kpi.name", input.kpi.name]] as [string, LocalizedText][]) : []),
  ];
  for (const [field, text] of complete) {
    const missing = missingLocales(text, LOCALES);
    if (missing.length) throw new ValidationError("missing_locales", { [field]: missing.join(",") });
  }
  const userId = ctx.actor.kind === "staff" ? ctx.actor.userId : null;
  const slug = input.automatedCommunication.automation_slug?.trim();
  const template = input.automatedCommunication.template_slug?.trim();
  const values = {
    pipeline: input.pipeline,
    stageKey: input.stageKey,
    sortOrder: input.sortOrder,
    name: input.name,
    requiredAction: input.requiredAction,
    ownerRole: input.ownerRole,
    deadlineDays: input.deadlineDays,
    defaultProbabilityPct: input.pipeline === "b2b" ? (input.defaultProbabilityPct ?? null) : null,
    automatedCommunication: { ...(slug ? { automation_slug: slug } : {}), ...(template ? { template_slug: template } : {}) },
    humanCommunication: hasText(input.humanCommunication) ? input.humanCommunication! : null,
    escalation: Object.fromEntries(Object.entries(input.escalation).filter(([, v]) => v !== undefined && v !== "")),
    kpi: { ...(hasText(input.kpi.name) ? { name: input.kpi.name } : {}), ...(input.kpi.target !== undefined ? { target: input.kpi.target } : {}), ...(input.kpi.unit ? { unit: input.kpi.unit } : {}) },
    isActive: input.isActive,
    updatedByUserId: userId,
  };
  const [before] = await ctx.tx
    .select()
    .from(playbookStages)
    .where(and(eq(playbookStages.pipeline, input.pipeline), eq(playbookStages.stageKey, input.stageKey)))
    .for("update");
  const [row] = before
    ? await ctx.tx.update(playbookStages).set({ ...values, updatedAt: ctx.now }).where(eq(playbookStages.id, before.id)).returning()
    : await ctx.tx.insert(playbookStages).values(values).returning();
  const view = (r: PlaybookStageRecord) => ({ ...r, id: undefined, createdAt: undefined, updatedAt: undefined });
  await ctx.audit({ action: "playbook.save", entityType: "playbook_stages", entityId: row!.id, ...(before ? { oldValue: view(before) } : {}), newValue: view(row!) });
  return { stageId: row!.id };
}
