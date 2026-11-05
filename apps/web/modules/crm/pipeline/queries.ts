/**
 * Pipeline queries (crm spec 4.3, 5.1), crm-P8. The board reads `v_opportunity_board`: one
 * column per open stage plus `account_management` and `renewal`, with value and weighted value
 * totals; won and lost opportunities leave the columns and are summed below the board.
 */
import type { DbOrTx } from "@beam/db";
import { companies, companyContacts, opportunities, persons, playbookStages, tasks, users, vOpportunityBoard, type OpportunityStage, type PlaybookPipeline } from "@beam/db/schema";
import type { TaskKind, TaskPriority, TaskStatus } from "@beam/core/crm";
import { and, asc, desc, eq, gte, inArray, isNull, sql, type SQL } from "@/lib/ctx";
import { listStaffForAssignment } from "@/modules/platform/api";
import { formatDate, formatMoney, type Locale } from "@beam/core/i18n";
import type { OpportunityFormLabels } from "../ui/pipeline/board";
import type { CardLabels, CardView } from "../ui/pipeline/card";
import type { StageDialogLabels } from "../ui/pipeline/stage-dialog";
import { BOARD_STAGES, canMoveStage, OPPORTUNITY_STAGES, type PlaybookStageRecord } from "./api";

export type OpportunityCard = {
  id: string;
  companyId: string;
  companyName: string;
  title: string;
  primaryContactPersonId: string | null;
  stage: OpportunityStage;
  stageEnteredAt: Date;
  valueCents: number;
  probabilityPct: number;
  expectedCloseOn: string | null;
  ownerUserId: string;
  ownerName: string | null;
  nextAction: string | null;
  nextActionAt: Date | null;
  lastContactAt: Date | null;
  stageDeadlineAt: Date | null;
  isStalled: boolean;
  version: number;
};

export type BoardColumn = { stage: OpportunityStage; cards: OpportunityCard[]; totalCents: number; weightedCents: number };
export type PipelineBoard = { columns: BoardColumn[]; won: { count: number; valueCents: number }; lost: { count: number } };

const cardColumns = {
  id: vOpportunityBoard.id,
  companyId: vOpportunityBoard.companyId,
  companyName: vOpportunityBoard.companyName,
  title: vOpportunityBoard.title,
  primaryContactPersonId: vOpportunityBoard.primaryContactPersonId,
  stage: vOpportunityBoard.stage,
  stageEnteredAt: vOpportunityBoard.stageEnteredAt,
  valueCents: vOpportunityBoard.valueCents,
  probabilityPct: vOpportunityBoard.probabilityPct,
  expectedCloseOn: vOpportunityBoard.expectedCloseOn,
  ownerUserId: vOpportunityBoard.ownerUserId,
  ownerName: vOpportunityBoard.ownerName,
  nextAction: vOpportunityBoard.nextAction,
  nextActionAt: vOpportunityBoard.nextActionAt,
  lastContactAt: vOpportunityBoard.lastContactAt,
  stageDeadlineAt: vOpportunityBoard.stageDeadlineAt,
  isStalled: vOpportunityBoard.isStalled,
  version: vOpportunityBoard.version,
};

/** Value weighted by probability, rounded to whole cents. */
export const weighted = (valueCents: number, probabilityPct: number) => Math.round((valueCents * probabilityPct) / 100);

export async function getPipelineBoard(tx: DbOrTx, input: { ownerUserId?: string; minValueCents?: number } = {}): Promise<PipelineBoard> {
  const where: SQL[] = [];
  if (input.ownerUserId) where.push(eq(vOpportunityBoard.ownerUserId, input.ownerUserId));
  if (input.minValueCents !== undefined && input.minValueCents > 0) where.push(gte(vOpportunityBoard.valueCents, input.minValueCents));
  const rows = await tx
    .select(cardColumns)
    .from(vOpportunityBoard)
    .where(and(inArray(vOpportunityBoard.stage, [...BOARD_STAGES]), ...where))
    .orderBy(asc(vOpportunityBoard.stageEnteredAt), asc(vOpportunityBoard.id));
  const columns: BoardColumn[] = BOARD_STAGES.map((stage) => ({ stage, cards: [], totalCents: 0, weightedCents: 0 }));
  const byStage = new Map(columns.map((c) => [c.stage, c] as const));
  for (const r of rows) {
    const col = byStage.get(r.stage);
    if (!col) continue;
    col.cards.push({ ...r, isStalled: !!r.isStalled });
    col.totalCents += r.valueCents;
    col.weightedCents += weighted(r.valueCents, r.probabilityPct);
  }
  const [closed] = await tx
    .select({
      won: sql<number>`count(*) filter (where ${opportunities.stage} = 'won')::int`,
      wonValue: sql<number>`coalesce(sum(${opportunities.valueCents}) filter (where ${opportunities.stage} = 'won'), 0)::int`,
      lost: sql<number>`count(*) filter (where ${opportunities.stage} = 'lost')::int`,
    })
    .from(opportunities)
    .where(
      and(
        input.ownerUserId ? eq(opportunities.ownerUserId, input.ownerUserId) : undefined,
        input.minValueCents ? gte(opportunities.valueCents, input.minValueCents) : undefined,
      ),
    );
  return { columns, won: { count: Number(closed?.won ?? 0), valueCents: Number(closed?.wonValue ?? 0) }, lost: { count: Number(closed?.lost ?? 0) } };
}

export async function listPlaybookStages(tx: DbOrTx, pipeline: PlaybookPipeline): Promise<PlaybookStageRecord[]> {
  return tx.select().from(playbookStages).where(eq(playbookStages.pipeline, pipeline)).orderBy(asc(playbookStages.sortOrder), asc(playbookStages.stageKey));
}

export type OpportunityTaskRow = { id: string; title: string; kind: TaskKind; priority: TaskPriority; status: TaskStatus; dueAt: Date | null; ownerName: string | null; isOverdue: boolean };

export type OpportunityDetail = OpportunityCard & {
  lostReason: string | null;
  wonAt: Date | null;
  lostAt: Date | null;
  source: string | null;
  notes: string | null;
  contactName: string | null;
  playbook: PlaybookStageRecord | null;
  tasks: OpportunityTaskRow[];
};

/** `/admin/pipeline/[id]`: the opportunity, the playbook card of its stage and its tasks (open first). */
export async function getOpportunity(tx: DbOrTx, id: string): Promise<OpportunityDetail | null> {
  const [card] = await tx.select(cardColumns).from(vOpportunityBoard).where(eq(vOpportunityBoard.id, id));
  if (!card) return null;
  const [extra] = await tx
    .select({
      lostReason: opportunities.lostReason,
      wonAt: opportunities.wonAt,
      lostAt: opportunities.lostAt,
      source: opportunities.source,
      notes: opportunities.notes,
      contactName: sql<string | null>`case when ${persons.id} is null then null when ${persons.erasedAt} is not null then null else nullif(trim(concat_ws(' ', ${persons.firstName}, ${persons.lastName})), '') end`,
    })
    .from(opportunities)
    .leftJoin(persons, eq(persons.id, opportunities.primaryContactPersonId))
    .where(eq(opportunities.id, id));
  const [playbook] = await tx
    .select()
    .from(playbookStages)
    .where(and(eq(playbookStages.pipeline, "b2b"), eq(playbookStages.stageKey, card.stage)));
  const taskRows = await tx
    .select({
      id: tasks.id,
      title: tasks.title,
      kind: tasks.kind,
      priority: tasks.priority,
      status: tasks.status,
      dueAt: tasks.dueAt,
      ownerName: sql<string | null>`coalesce(${users.name}, ${users.email})`,
      isOverdue: sql<boolean>`coalesce(${tasks.status} = 'open' and ${tasks.dueAt} < now(), false)`,
    })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.ownerUserId))
    .where(eq(tasks.opportunityId, id))
    .orderBy(sql`(${tasks.status} = 'open') desc`, asc(tasks.dueAt), desc(tasks.createdAt))
    .limit(100);
  return {
    ...card,
    isStalled: !!card.isStalled,
    lostReason: extra?.lostReason ?? null,
    wonAt: extra?.wonAt ?? null,
    lostAt: extra?.lostAt ?? null,
    source: extra?.source ?? null,
    notes: extra?.notes ?? null,
    contactName: extra?.contactName ?? null,
    playbook: playbook ?? null,
    tasks: taskRows.map((t) => ({ ...t, isOverdue: !!t.isOverdue })),
  };
}

export type OpportunityFormOptions = {
  companies: { value: string; label: string }[];
  contacts: { value: string; label: string; companyId: string }[];
  owners: { value: string; label: string }[];
};

/** The selects of the opportunity form: companies by name, their current contacts and the staff holding `crm.b2b`. */
export async function getOpportunityFormOptions(tx: DbOrTx): Promise<OpportunityFormOptions> {
  const companyRows = await tx
    .select({ value: companies.id, label: companies.name })
    .from(companies)
    .orderBy(sql`lower(${companies.name})`, asc(companies.id))
    .limit(1000);
  const contactRows = await tx
    .select({
      value: persons.id,
      companyId: companyContacts.companyId,
      label: sql<string>`coalesce(nullif(trim(concat_ws(' ', ${persons.firstName}, ${persons.lastName})), ''), 'C-' || lpad(${persons.customerNumber}::text, 6, '0'))`,
    })
    .from(companyContacts)
    .innerJoin(persons, eq(persons.id, companyContacts.personId))
    .where(and(isNull(companyContacts.endedOn), isNull(persons.erasedAt), isNull(persons.mergedIntoPersonId)))
    .orderBy(desc(companyContacts.isPrimary), asc(persons.lastName), asc(persons.id));
  const owners = await listStaffForAssignment(tx, { permission: "crm.b2b" });
  return { companies: companyRows, contacts: contactRows, owners: owners.map((o) => ({ value: o.userId, label: o.name })) };
}

// ---------------------------------------------------------------------------
// View models and labels of the pipeline screens (formatted on the server)
// ---------------------------------------------------------------------------

type Tr = (key: string, params?: Record<string, string | number>) => string;

const initials = (name: string | null) =>
  (name ?? "?")
    .split(/\s+|@/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("") || "?";

/** The board card of one opportunity, every value formatted for `locale`. */
export function cardView(o: OpportunityCard, locale: Locale): CardView {
  return {
    id: o.id,
    version: o.version,
    stage: o.stage,
    companyName: o.companyName,
    title: o.title,
    value: formatMoney(o.valueCents, locale, { hideZeroDecimals: true }),
    probability: `${o.probabilityPct} %`,
    expectedClose: o.expectedCloseOn ? formatDate(o.expectedCloseOn, locale) : null,
    ownerName: o.ownerName,
    ownerInitials: initials(o.ownerName),
    nextAction: o.nextAction,
    lastContact: o.lastContactAt ? formatDate(o.lastContactAt, locale) : null,
    isStalled: o.isStalled,
    hasContact: !!o.primaryContactPersonId,
    allowed: OPPORTUNITY_STAGES.filter((s) => canMoveStage(o.stage, s)),
  };
}

export function stageNames(tr: Tr): Record<string, string> {
  return Object.fromEntries(OPPORTUNITY_STAGES.map((s) => [s, tr(`crm.enums.opportunity_stage.${s}`)]));
}

export function stageDialogLabels(tr: Tr): StageDialogLabels {
  const d = (k: string) => tr(`crm.pipeline.dialog.${k}`);
  return {
    title: d("title"),
    description: d("description"),
    stage: d("stage"),
    lostReason: d("lost_reason"),
    submit: d("submit"),
    saving: tr("crm.common.saving"),
    cancel: tr("crm.common.cancel"),
    error: tr("crm.common.error"),
    stale: d("stale"),
    notAllowed: d("not_allowed"),
    reasonRequired: d("reason_required"),
    stages: stageNames(tr),
  };
}

export function cardLabels(tr: Tr): CardLabels {
  const c = (k: string) => tr(`crm.pipeline.card.${k}`);
  return { expectedClose: c("expected_close"), lastContact: c("last_contact"), never: c("never"), nextAction: c("next_action"), stalled: c("stalled"), noContact: c("no_contact"), move: c("move") };
}

export function opportunityFormLabels(tr: Tr): OpportunityFormLabels {
  const f = (k: string) => tr(`crm.pipeline.form.${k}`);
  return {
    titleNew: f("title_new"),
    titleEdit: f("title_edit"),
    company: f("company"),
    title: f("title"),
    contact: f("contact"),
    noContact: f("no_contact"),
    value: f("value"),
    probability: f("probability"),
    probabilityHint: f("probability_hint"),
    expectedClose: f("expected_close"),
    owner: f("owner"),
    nextAction: f("next_action"),
    nextActionAt: f("next_action_at"),
    source: f("source"),
    notes: f("notes"),
    save: tr("crm.common.save"),
    saving: tr("crm.common.saving"),
    cancel: tr("crm.common.cancel"),
    error: f("error"),
    stale: tr("crm.pipeline.dialog.stale"),
    forbidden: f("forbidden"),
  };
}
