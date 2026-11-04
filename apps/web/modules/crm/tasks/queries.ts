/**
 * Task queries (crm spec 4.3, rule 3.43), crm-P6. Overdue means `status = 'open'` and
 * `due_at < now`; due today is the current calendar day in Europe/Brussels. "My tasks" lists
 * overdue tasks first. `now` is optional for tests and defaults to the database clock.
 */
import type { DbOrTx } from "@beam/db";
import { companies, persons, tasks, users } from "@beam/db/schema";
import type { TaskKind, TaskPriority, TaskSource, TaskStatus } from "@beam/core/crm";
import { and, asc, eq, sql, type SQL } from "@/lib/ctx";

export type TaskRow = {
  id: string;
  title: string;
  kind: TaskKind;
  priority: TaskPriority;
  status: TaskStatus;
  source: TaskSource;
  dueAt: Date | null;
  isOverdue: boolean;
  isDueToday: boolean;
  owner: { id: string; name: string | null; disabled: boolean };
  personId: string | null;
  companyId: string | null;
  personName: string | null;
  companyName: string | null;
  notes: string | null;
  doneAt: Date | null;
};

const nowSql = (now?: Date): SQL => (now ? sql`${now.toISOString()}::timestamptz` : sql`now()`);

/** Start and end of the Brussels calendar day that contains `now`. */
const dayStart = (now?: Date): SQL => sql`(date_trunc('day', ${nowSql(now)} at time zone 'Europe/Brussels') at time zone 'Europe/Brussels')`;
const dayEnd = (now?: Date): SQL => sql`((date_trunc('day', ${nowSql(now)} at time zone 'Europe/Brussels') + interval '1 day') at time zone 'Europe/Brussels')`;

const overdueSql = (now?: Date): SQL => sql`(${tasks.status} = 'open' and ${tasks.dueAt} < ${nowSql(now)})`;
const dueTodaySql = (now?: Date): SQL => sql`(${tasks.status} = 'open' and ${tasks.dueAt} >= ${dayStart(now)} and ${tasks.dueAt} < ${dayEnd(now)})`;

export function listTasks(
  tx: DbOrTx,
  input: {
    userId: string;
    scope: "mine" | "all";
    status?: TaskStatus;
    overdueOnly?: boolean;
    dueToday?: boolean;
    personId?: string;
    companyId?: string;
    opportunityId?: string;
    /** Test clock; defaults to `now()`. */
    now?: Date;
    limit?: number;
  },
): Promise<TaskRow[]> {
  // `tasks.opportunity_id` arrives in R3 (crm-P8); before that no task belongs to an opportunity.
  if (input.opportunityId) return Promise.resolve([]);
  const where: SQL[] = [];
  if (input.scope === "mine") where.push(eq(tasks.ownerUserId, input.userId));
  const status = input.overdueOnly || input.dueToday ? "open" : input.status;
  if (status) where.push(eq(tasks.status, status));
  if (input.overdueOnly) where.push(overdueSql(input.now));
  if (input.dueToday) where.push(dueTodaySql(input.now));
  if (input.personId) where.push(eq(tasks.personId, input.personId));
  if (input.companyId) where.push(eq(tasks.companyId, input.companyId));

  const overdue = overdueSql(input.now);
  return tx
    .select({
      id: tasks.id,
      title: tasks.title,
      kind: tasks.kind,
      priority: tasks.priority,
      status: tasks.status,
      source: tasks.source,
      dueAt: tasks.dueAt,
      isOverdue: sql<boolean>`coalesce(${overdue}, false)`,
      isDueToday: sql<boolean>`coalesce(${dueTodaySql(input.now)}, false)`,
      ownerId: tasks.ownerUserId,
      ownerName: sql<string | null>`coalesce(${users.name}, ${users.email})`,
      ownerStatus: users.status,
      personId: tasks.personId,
      companyId: tasks.companyId,
      personName: sql<string | null>`nullif(trim(concat_ws(' ', ${persons.firstName}, ${persons.lastName})), '')`,
      companyName: companies.name,
      notes: tasks.notes,
      doneAt: tasks.doneAt,
    })
    .from(tasks)
    .innerJoin(users, eq(users.id, tasks.ownerUserId))
    .leftJoin(persons, eq(persons.id, tasks.personId))
    .leftJoin(companies, eq(companies.id, tasks.companyId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(
      sql`case when coalesce(${overdue}, false) then 0 else 1 end`,
      sql`case ${tasks.status} when 'open' then 0 else 1 end`,
      sql`${tasks.dueAt} asc nulls last`,
      sql`case ${tasks.priority} when 'high' then 0 when 'normal' then 1 else 2 end`,
      asc(tasks.createdAt),
      asc(tasks.id),
    )
    .limit(Math.min(Math.max(input.limit ?? 200, 1), 500))
    .then((rows) =>
      rows.map(({ ownerId, ownerName, ownerStatus, ...r }) => ({
        ...r,
        isOverdue: !!r.isOverdue,
        isDueToday: !!r.isDueToday,
        owner: { id: ownerId, name: ownerName, disabled: ownerStatus !== "active" },
      })),
    );
}

/** The owner's open, overdue and due-today counts (nav badge, "My tasks" header). */
export async function getTaskCounts(tx: DbOrTx, userId: string, opts: { now?: Date } = {}): Promise<{ open: number; overdue: number; dueToday: number }> {
  const [row] = await tx
    .select({
      open: sql<number>`count(*)::int`,
      overdue: sql<number>`(count(*) filter (where ${overdueSql(opts.now)}))::int`,
      dueToday: sql<number>`(count(*) filter (where ${dueTodaySql(opts.now)}))::int`,
    })
    .from(tasks)
    .where(and(eq(tasks.ownerUserId, userId), eq(tasks.status, "open")));
  return { open: Number(row?.open ?? 0), overdue: Number(row?.overdue ?? 0), dueToday: Number(row?.dueToday ?? 0) };
}
