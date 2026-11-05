/**
 * The retention engine (ops rules 19-22, ops-P7, R2). `buildWeeklyRetentionList` turns
 * `v_retention_candidates` into this week's `retention_lists` row and its items: one item per
 * person with their highest score (`primary_reason`) and every reason, people with a recent
 * retention task left out (cooldown), the top `weekly_list_size` by score, revenue and person id.
 * A rebuild in the same week replaces only items without a task and not dismissed; the kept items
 * keep their rank and the new ones take the free ranks in score order.
 *
 * Concurrency (rule 20): the build first inserts the week's row with `on conflict do nothing`,
 * then locks it `for update`, so the Monday job and a manual rebuild never interleave.
 *
 * The item operations of rules 21 and 22 ("Create task", "Create all tasks", "Dismiss") live here
 * too, so `actions.ts` stays a thin "use server" file.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { retentionListItems, retentionLists, users } from "@beam/db/schema";
import { t, type Locale } from "@beam/core/i18n";
import { brusselsDate, RETENTION_DEFAULTS, RETENTION_DISMISS_REASONS, RETENTION_REASONS, type RetentionDefaults, type RetentionDismissReason, type RetentionReason } from "@beam/core/ops";
import { notifySlack } from "@/lib/alerts";
import { appUrl } from "@/lib/auth";
import { and, asc, ConflictError, eq, isNull, NotFoundError, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { getSetting } from "@/lib/settings";
import { createTask, type EventCtx } from "@/modules/crm/api";
import { taskDueAt } from "../dashboard/cards";

/** The highest rank `retention_list_items_rank_ck` allows. */
export const MAX_LIST_SIZE = 100;
/** Rule 21: a task on an item with this score or more gets priority `high`. */
export const HIGH_PRIORITY_SCORE = 80;

/** The Monday (Brussels date) of the ISO week that contains `at`. */
export function weekStartOf(at: Date): string {
  const day = new Date(`${brusselsDate(at)}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

/** `settings.retention_defaults`, or the registry default when the row cannot be read. */
export async function readRetentionDefaults(db: DbOrTx): Promise<RetentionDefaults> {
  try {
    return await getSetting(db, "retention_defaults");
  } catch {
    return RETENTION_DEFAULTS;
  }
}

type Candidate = { person_id: string; score: number; primary_reason: RetentionReason; reasons: RetentionReason[]; detail: Record<string, unknown> | string };

/**
 * Rule 20. Builds (or rebuilds) the list of the week starting `weekStartOn` and returns its id
 * and its number of items. Runs in the caller's transaction.
 */
export async function buildWeeklyRetentionList(tx: Tx, weekStartOn: string, cfg: RetentionDefaults): Promise<{ listId: string; size: number }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStartOn)) throw new ValidationError("validation", { weekStartOn: "invalid" });
  const size = Math.max(1, Math.min(MAX_LIST_SIZE, Math.trunc(cfg.weekly_list_size)));
  const thresholds = JSON.stringify(cfg);

  await tx.execute(sql`insert into retention_lists (week_start_on, size, thresholds, generated_at)
    values (${weekStartOn}::date, 0, ${thresholds}::jsonb, now()) on conflict (week_start_on) do nothing`);
  const [list] = rowsOf<{ id: string }>(await tx.execute(sql`select id from retention_lists where week_start_on = ${weekStartOn}::date for update`));
  const listId = list!.id;

  await tx.delete(retentionListItems).where(and(eq(retentionListItems.listId, listId), isNull(retentionListItems.taskId), isNull(retentionListItems.dismissedAt)));
  const kept = await tx.select({ personId: retentionListItems.personId, rank: retentionListItems.rank }).from(retentionListItems).where(eq(retentionListItems.listId, listId));
  const slots = Math.max(0, size - kept.length);

  const candidates =
    slots === 0
      ? []
      : rowsOf<Candidate>(
          await tx.execute(sql`with c as (select person_id, reason, score, ref_type, ref_id, detail from v_retention_candidates),
              r as (select person_id, reason, max(score) as score from c group by 1, 2),
              best as (select distinct on (person_id) person_id, reason, score, ref_type, ref_id, detail
                       from c order by person_id, score desc, reason, ref_id)
            select b.person_id, b.score::int as score, b.reason as primary_reason,
                   (select array_agg(r.reason order by r.score desc, r.reason) from r where r.person_id = b.person_id) as reasons,
                   b.detail || jsonb_build_object('ref_type', b.ref_type, 'ref_id', b.ref_id) as detail
            from best b left join person_stats ps on ps.person_id = b.person_id
            where not exists (select 1 from tasks tk where tk.person_id = b.person_id and tk.source = 'retention'
                                and tk.status in ('open', 'done') and tk.created_at >= now() - make_interval(days => ${Math.trunc(cfg.task_cooldown_days)}::int))
              and not exists (select 1 from retention_list_items k where k.list_id = ${listId}::uuid and k.person_id = b.person_id)
            order by b.score desc, coalesce(ps.revenue_cents, 0) desc, b.person_id
            limit ${slots}`),
        );

  const taken = new Set(kept.map((k) => k.rank));
  const free: number[] = [];
  for (let rank = 1; rank <= MAX_LIST_SIZE && free.length < candidates.length; rank++) if (!taken.has(rank)) free.push(rank);
  if (candidates.length) {
    await tx.insert(retentionListItems).values(
      candidates.map((c, i) => ({
        listId,
        rank: free[i]!,
        personId: c.person_id,
        score: Number(c.score),
        primaryReason: c.primary_reason,
        reasons: pgArray(c.reasons),
        detail: typeof c.detail === "string" ? (JSON.parse(c.detail) as Record<string, unknown>) : c.detail,
      })),
    );
  }
  const total = kept.length + candidates.length;
  await tx.update(retentionLists).set({ size: total, thresholds: cfg, generatedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(retentionLists.id, listId));
  return { listId, size: total };
}

/** A Postgres `text[]` read through `execute` may arrive as `{a,b}`. */
function pgArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return v.replace(/^\{|\}$/g, "").split(",").filter(Boolean).map((s) => s.replace(/^"|"$/g, ""));
  return [];
}

// ---------------------------------------------------------------------------------------------
// The Slack notice (rule 20, blueprint 22): counts per primary reason and the link, no names.
// ---------------------------------------------------------------------------------------------

/** "Weekly retention list ready: 25 people, 9 packages expiring", then the counts per primary reason and the link. */
export async function retentionNoticeText(db: DbOrTx, listId: string, weekStartOn: string): Promise<string> {
  const counts = await db
    .select({ reason: retentionListItems.primaryReason, n: sql<number>`count(*)::int` })
    .from(retentionListItems)
    .where(eq(retentionListItems.listId, listId))
    .groupBy(retentionListItems.primaryReason);
  const by = new Map(counts.map((c) => [c.reason, Number(c.n)]));
  const total = [...by.values()].reduce((a, b) => a + b, 0);
  const expiring = by.get("package_expiring") ?? 0;
  const lines = (RETENTION_REASONS as readonly string[])
    .filter((r) => by.get(r))
    .map((r) => `${t("en", `ops.retention.reason.${r}`)}: ${by.get(r)}`);
  return [
    `Weekly retention list ready for the week of ${weekStartOn}: ${total} ${total === 1 ? "person" : "people"}, ${expiring} ${expiring === 1 ? "package" : "packages"} expiring`,
    ...lines.map((l) => `- ${l}`),
    appUrl("/admin/dashboard/retention"),
  ].join("\n");
}

/** Posts the notice once per week (`retention-list:<week>`). */
export async function postRetentionNotice(ctx: Ctx, listId: string, weekStartOn: string): Promise<void> {
  await notifySlack(ctx, { fingerprint: `retention-list:${weekStartOn}`, severity: "normal", text: await retentionNoticeText(ctx.tx, listId, weekStartOn) });
}

// ---------------------------------------------------------------------------------------------
// Rule 21: "Create task" and "Create all tasks"
// ---------------------------------------------------------------------------------------------

type ItemRow = { id: string; list_id: string; person_id: string; score: number; primary_reason: string; task_id: string | null; dismissed_at: string | Date | null };

async function lockItem(tx: Tx, itemId: string): Promise<ItemRow> {
  const [item] = rowsOf<ItemRow>(
    await tx.execute(sql`select id, list_id, person_id, score, primary_reason, task_id, dismissed_at from retention_list_items where id = ${itemId}::uuid for update`),
  );
  if (!item) throw new NotFoundError("retention_item_not_found");
  return item;
}

async function ownerLocale(tx: DbOrTx, ownerUserId: string | undefined): Promise<Locale> {
  if (!ownerUserId) return "nl-BE";
  const [owner] = await tx.select({ locale: users.locale }).from(users).where(eq(users.id, ownerUserId));
  if (!owner) throw new ValidationError("validation", { ownerUserId: "not_found" });
  return owner.locale;
}

/** The title of a retention task in `locale` (`ops.retention.task_title.<reason>`). */
export function retentionTaskTitle(reason: string, locale: Locale): string {
  return t(locale, `ops.retention.task_title.${reason}`);
}

/**
 * Rule 21. Locks the item `for update`; returns its task when it has one (a second click or tab),
 * else creates one crm task (`follow_up`, source `retention`, priority by score, due the next
 * business day at 10:00 Brussels, ref `retention_list_item`) and stores `task_id`.
 */
export async function createRetentionItemTask(tx: Tx, ctx: EventCtx, input: { itemId: string; ownerUserId?: string }): Promise<{ taskId: string; created: boolean }> {
  const item = await lockItem(tx, input.itemId);
  if (item.task_id) return { taskId: item.task_id, created: false };
  if (item.dismissed_at) throw new ConflictError("retention_item_dismissed");
  const staffId = ctx.actor.kind === "staff" ? ctx.actor.userId : undefined;
  const ownerUserId = input.ownerUserId ?? staffId;
  const locale = await ownerLocale(tx, ownerUserId);
  const result = await createTask(tx, ctx, {
    title: retentionTaskTitle(item.primary_reason, locale),
    kind: "follow_up",
    ...(ownerUserId ? { ownerUserId } : {}),
    personId: item.person_id,
    dueAt: await taskDueAt(tx, ctx.now),
    priority: Number(item.score) >= HIGH_PRIORITY_SCORE ? "high" : "normal",
    source: "retention",
    ref: { type: "retention_list_item", id: item.id },
    dedupeKey: `retention_item:${item.id}`,
  });
  await tx
    .update(retentionListItems)
    .set({ taskId: result.taskId, actionedAt: ctx.now, actionedByUserId: staffId ?? null, updatedAt: ctx.now })
    .where(eq(retentionListItems.id, item.id));
  return result;
}

/** Rule 21 "Create all tasks": every item of the list without a task and not dismissed, in rank order, in the caller's transaction. */
export async function createAllRetentionItemTasks(tx: Tx, ctx: EventCtx, input: { listId: string; ownerUserId?: string }): Promise<{ created: number; taskIds: string[] }> {
  const [list] = rowsOf<{ id: string }>(await tx.execute(sql`select id from retention_lists where id = ${input.listId}::uuid for update`));
  if (!list) throw new NotFoundError("retention_list_not_found");
  const open = await tx
    .select({ id: retentionListItems.id })
    .from(retentionListItems)
    .where(and(eq(retentionListItems.listId, input.listId), isNull(retentionListItems.taskId), isNull(retentionListItems.dismissedAt)))
    .orderBy(asc(retentionListItems.rank));
  const taskIds: string[] = [];
  let created = 0;
  for (const item of open) {
    const r = await createRetentionItemTask(tx, ctx, { itemId: item.id, ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}) });
    if (r.created) created++;
    taskIds.push(r.taskId);
  }
  return { created, taskIds };
}

// ---------------------------------------------------------------------------------------------
// Rule 22: "Dismiss"
// ---------------------------------------------------------------------------------------------

/** Rule 22. Requires one of the four reasons and keeps the row; a second dismissal keeps the first reason. */
export async function dismissRetentionListItem(
  tx: Tx,
  ctx: Pick<Ctx, "actor" | "now">,
  input: { itemId: string; reason: RetentionDismissReason; note?: string },
): Promise<{ ok: true; personId: string; alreadyDismissed: boolean }> {
  if (!(RETENTION_DISMISS_REASONS as readonly string[]).includes(input.reason ?? "")) throw new ValidationError("validation", { reason: "required" });
  const item = await lockItem(tx, input.itemId);
  if (item.dismissed_at) return { ok: true, personId: item.person_id, alreadyDismissed: true };
  await tx
    .update(retentionListItems)
    .set({ dismissedAt: ctx.now, dismissReason: input.reason, actionedAt: ctx.now, actionedByUserId: ctx.actor.kind === "staff" ? ctx.actor.userId : null, updatedAt: ctx.now })
    .where(eq(retentionListItems.id, item.id));
  return { ok: true, personId: item.person_id, alreadyDismissed: false };
}
