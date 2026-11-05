/**
 * The action dashboard cards (ops rules 22a, 22b, 23-33, ops-P3). Each card is one live SQL
 * query (no cache, rule 33) returning its count and its first rows, with the window of the
 * Today view or, for This week (`?view=week`), every date horizon widened by
 * `dashboard_week_horizon_days` (rule 22b). Cards are shown per permission (ops spec 7).
 *
 * `createCardTask` is rule 22a: "Create task" on a card row, one open crm task per person, card
 * and referenced row, due the next business day at 10:00 Brussels.
 *
 * V1 cards: packages nearing completion (23), VIP inactive (24), new leads (25), memberships
 * expiring (27), failed payments (28), webinar leads from imported registrations (29), unused
 * packages expiring (30), overdue tasks (32) and privacy requests near their due date (screen
 * table, `privacy.run`). `b2b_proposals` (R3) is added by its release package.
 *
 * R2 (ops-P7): rule 29's native part comes from webinar's one definition: the count is
 * `countWebinarLeadsWithoutBooking(db, { startedSince })` and the first rows come from
 * `listWebinarLeadsWithoutBooking`; the imported (old-tool) registrations keep the V1 query and
 * are shown apart as `secondary` ("imported"), their rows after the native ones. Rule 31's
 * `shared_package_abuse` counts credits' `countSharingReviewItems` plus the flagged waitlist
 * entries, lists credits' `listSharingReview` rows then those entries, and links to credits'
 * review screen. A card with a `load` function computes itself; the others are one SQL query.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { creditGrants, persons, sessionExceptions, tasks, users } from "@beam/db/schema";
import { DEFAULT_BUSINESS_HOURS } from "@beam/core/booking";
import type { TaskKind } from "@beam/core/crm";
import { t, type Locale } from "@beam/core/i18n";
import { nextBusinessDay, periodRange, type ActionCardKey, type RetentionDefaults, type RetentionReason } from "@beam/core/ops";
import { NotImplementedError } from "@beam/core/errors";
import { and, eq, gte, inArray, isNull, lte, NotFoundError, sql, ValidationError, type Actor, type Permission, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { getSetting } from "@/lib/settings";
import { countSharingReviewItems, listSharingReview } from "@/modules/credits/api";
import { createTask, type EventCtx } from "@/modules/crm/api";
import { countWebinarLeadsWithoutBooking, listWebinarLeadsWithoutBooking } from "@/modules/webinar/api";
import { holdsAny } from "../reports/registry";
import { brusselsDate } from "../reports/revenue";

export type DashboardView = "today" | "week";

/** One row of a card: the person (null for a task without one), the referenced row and the figures of `ops.dashboard.card.<key>.row`. */
export type ActionCardRow = {
  personId: string | null;
  name: string | null;
  refType: string;
  refId: string;
  /** Row text parameters: `date` is an ISO instant or date, `amount` cents, the rest numbers or strings. */
  params: Record<string, string | number | null>;
};

export type ActionCard = {
  key: ActionCardKey;
  count: number;
  rows: ActionCardRow[];
  /** "Create task" is offered on the rows (the card makes tasks and the actor holds `tasks.all`). */
  canCreateTask: boolean;
  /** A second figure shown apart from `count` (rule 29: the imported registrations, label `ops.dashboard.card.<key>.secondary`). */
  secondary?: { key: "imported"; count: number };
  /** Where the card's list is worked on, when another module's screen owns it (rule 31: credits' sharing review). */
  linkHref?: string;
};

export type CardEnv = { now: Date; cfg: RetentionDefaults; add: number; view: DashboardView; actor: Actor };

type CardDef = {
  key: ActionCardKey;
  /** The actor sees the card when holding one of these (on top of the dashboard's own permission). */
  anyOf: readonly Permission[] | null;
  /** The retention reason of a retention-reason card (task source `retention`, title from `ops.retention.task_title.<reason>`). */
  reason?: RetentionReason;
  createsTasks: boolean;
  query: (env: CardEnv) => { base: SQL; order: SQL };
  /** A card that computes itself (R2 cards over other modules' api); `sqlCard` runs `query` as a plain card. */
  load?: (db: DbOrTx, env: CardEnv, limit: number, sqlCard: () => Promise<ActionCard>) => Promise<ActionCard>;
};

/** The permissions that open the dashboard itself (ops spec 7). */
export const DASHBOARD_PERMISSIONS: readonly Permission[] = ["reports.read", "tasks.all"];

const ts = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;
const days = (n: number): SQL => sql`(${n}::int * interval '1 day')`;
/** A person who is neither a tester, nor erased, nor merged. */
const realPerson = (alias: string): SQL => sql.raw(`${alias}.is_tester = false and ${alias}.erased_at is null and ${alias}.merged_into_person_id is null`);

function retentionReasonCard(key: ActionCardKey, reason: RetentionReason, params: string): CardDef {
  return {
    key,
    anyOf: key === "vip_inactive" ? null : ["credits.read", "reports.read"],
    reason,
    createsTasks: true,
    query: () => ({
      base: sql`select rc.person_id, rc.ref_type::text as ref_type, rc.ref_id::text as ref_id, rc.score::numeric as sort1, ${sql.raw(params)} as params
        from v_retention_candidates rc where rc.reason = ${reason}`,
      order: sql`b.sort1 desc, b.person_id, b.ref_id`,
    }),
  };
}

export const CARDS: readonly CardDef[] = [
  // Rule 23
  retentionReasonCard("packages_nearing_completion", "package_nearly_finished", `jsonb_build_object('remaining', rc.detail->'remaining', 'total', rc.detail->'units_granted', 'product', rc.detail->'product_name')`),
  // Rule 24
  retentionReasonCard("vip_inactive", "high_value_inactive", `jsonb_build_object('days', rc.detail->'days_since_activity')`),
  // Rule 25
  {
    key: "new_leads_follow_up",
    anyOf: null,
    createsTasks: true,
    query: ({ now, cfg, add }) => ({
      base: sql`select pp.person_id, 'person' as ref_type, pp.person_id::text as ref_id, extract(epoch from pp.created_at)::numeric as sort1,
          jsonb_build_object('date', pp.created_at) as params
        from v_person_profile pp
        where pp.is_tester = false and pp.status = 'lead'
          and pp.created_at >= ${ts(now)} - ${days(cfg.new_lead_window_days + add)}
          and pp.created_at <= ${ts(now)} - (${cfg.new_lead_followup_hours}::int * interval '1 hour')
          and coalesce(pp.acquisition_source, '') <> 'import'
          and not exists (select 1 from bookings bk where bk.person_id = pp.person_id)
          and not exists (select 1 from tasks tk where tk.person_id = pp.person_id)`,
      order: sql`b.sort1 asc, b.person_id`,
    }),
  },
  // Rule 27
  {
    key: "memberships_expiring",
    anyOf: ["credits.read", "reports.read"],
    createsTasks: true,
    query: ({ now, cfg, add }) => {
      const horizon = sql`${ts(now)} + ${days(cfg.membership_expiring_days + add)}`;
      return {
        base: sql`select m.person_id, 'membership' as ref_type, m.id::text as ref_id,
            extract(epoch from coalesce(m.cancel_at, m.current_period_end_at))::numeric as sort1,
            jsonb_build_object('date', coalesce(m.cancel_at, m.current_period_end_at), 'status', m.status) as params
          from memberships m join persons pe on pe.id = m.person_id
          where ${realPerson("pe")} and (
            (m.status = 'active' and m.cancel_at is not null and m.cancel_at <= ${horizon})
            or m.status = 'past_due'
            or (m.status = 'active' and m.current_period_end_at <= ${horizon}
                and not exists (select 1 from mandates md where md.id = m.mandate_id and md.status = 'valid')))`,
        order: sql`b.sort1 asc, b.ref_id`,
      };
    },
  },
  // Rule 28: the 7-day look-back is not one of rule 22b's widened horizons.
  {
    key: "failed_payments",
    anyOf: ["reports.read", "commerce.sell"],
    createsTasks: true,
    query: ({ now }) => ({
      base: sql`select * from (
          select distinct on (pm.order_id) o.person_id, 'payment' as ref_type, pm.id::text as ref_id, extract(epoch from pm.created_at)::numeric as sort1,
            jsonb_build_object('amount', pm.amount_cents, 'date', pm.created_at, 'status', pm.status) as params
          from payments pm join orders o on o.id = pm.order_id join persons pe on pe.id = o.person_id
          where ${realPerson("pe")} and o.paid_at is null and o.status in ('pending_payment', 'expired', 'cancelled', 'draft')
            and ((pm.status in ('failed', 'expired') and pm.updated_at >= ${ts(now)} - ${days(7)})
              or (pm.status in ('pending', 'open') and pm.created_at < ${ts(now)} - interval '15 minutes'
                  and pm.created_at >= ${ts(now)} - ${days(7)}))
          order by pm.order_id, pm.created_at desc) fp`,
      order: sql`b.sort1 desc, b.ref_id`,
    }),
  },
  // Rule 29, V1 part: registrations imported from the current webinar tool. The `webinar_tool`
  // applier stores `{ provider, external_webinar_id, title, starts_at }`, the generic history
  // import `webinar_title` and `webinar_starts_at`; both are read.
  {
    key: "webinar_leads_not_booked",
    anyOf: null,
    createsTasks: true,
    load: loadWebinarLeads,
    query: ({ now, cfg, add }) => ({
      base: sql`select * from (
          select distinct on (ih.person_id) ih.person_id, 'imported_history' as ref_type, ih.id::text as ref_id,
            extract(epoch from ih.occurred_at)::numeric as sort1,
            jsonb_build_object('date', ih.occurred_at, 'webinar', coalesce(ih.data->>'webinar_title', ih.data->>'title')) as params
          from imported_history ih join v_person_profile pp on pp.person_id = ih.person_id
          where ih.kind = 'webinar_registration' and pp.is_tester = false and pp.status = 'lead'
            and (case when coalesce(ih.data->>'webinar_starts_at', ih.data->>'starts_at') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                      then coalesce(ih.data->>'webinar_starts_at', ih.data->>'starts_at')::timestamptz else ih.occurred_at end)
                between ${ts(now)} - ${days(cfg.webinar_lead_window_days + add)} and ${ts(now)}
            and not exists (select 1 from bookings bk where bk.person_id = ih.person_id and bk.created_at > ih.occurred_at)
          order by ih.person_id, ih.occurred_at desc) wl`,
      order: sql`b.sort1 desc, b.person_id`,
    }),
  },
  // Rule 31 (R2): credits' sharing review items plus flagged waitlist entries; reviewed on credits' screen.
  {
    key: "shared_package_abuse",
    anyOf: ["credits.read"],
    createsTasks: true,
    load: loadSharedPackageAbuse,
    query: () => ({ base: FLAGGED_WAITLIST, order: sql`b.sort1 desc, b.ref_id` }),
  },
  // Rule 30: rows of reason `package_expiring`, the expiry window widened in the week view.
  {
    key: "unused_packages_expiring",
    anyOf: ["credits.read", "reports.read"],
    reason: "package_expiring",
    createsTasks: true,
    query: ({ now, cfg, add }) => ({
      base: sql`select gb.person_id, 'grant' as ref_type, gb.grant_id::text as ref_id, extract(epoch from gb.expires_at)::numeric as sort1,
          jsonb_build_object('remaining', gb.remaining_units, 'date', gb.expires_at) as params
        from v_credit_grant_balances gb join v_person_profile pp on pp.person_id = gb.person_id
        where pp.is_tester = false and gb.status = 'active' and gb.remaining_units > 0 and gb.expires_at is not null
          and gb.expires_at > ${ts(now)} and gb.expires_at <= ${ts(now)} + ${days(cfg.expiry_days + add)}`,
      order: sql`b.sort1 asc, b.ref_id`,
    }),
  },
  // Rule 32: own open tasks past due (every user's with `tasks.all`); the week view runs to the end of the ISO week.
  {
    key: "overdue_tasks",
    anyOf: null,
    createsTasks: false,
    query: ({ now, view, actor }) => {
      const until = view === "week" ? periodRange("week", now).to : now;
      const own = holdsAny(actor, "tasks.all") || actor.kind !== "staff" ? sql`true` : sql`tk.owner_user_id = ${actor.userId}::uuid`;
      return {
        base: sql`select tk.person_id, 'task' as ref_type, tk.id::text as ref_id, extract(epoch from tk.due_at)::numeric as sort1,
            jsonb_build_object('date', tk.due_at, 'title', tk.title) as params
          from tasks tk where tk.status = 'open' and tk.due_at is not null and tk.due_at < ${ts(until)} and ${own}`,
        order: sql`b.sort1 asc, b.ref_id`,
      };
    },
  },
  // Screen table: open privacy requests due within 7 days (or overdue).
  {
    key: "overdue_privacy_requests",
    anyOf: ["privacy.run"],
    createsTasks: false,
    query: ({ now, add }) => ({
      base: sql`select pr.person_id, 'privacy_request' as ref_type, pr.id::text as ref_id, extract(epoch from pr.due_on::timestamp)::numeric as sort1,
          jsonb_build_object('date', pr.due_on, 'kind', pr.kind) as params
        from privacy_requests pr
        where pr.status in ('received', 'verified', 'running') and pr.due_on <= ${brusselsDate(now)}::date + ${7 + add}::int`,
      order: sql`b.sort1 asc, b.ref_id`,
    }),
  },
];

export const CARD_BY_KEY: ReadonlyMap<ActionCardKey, CardDef> = new Map(CARDS.map((c) => [c.key, c]));

/** Whether the actor sees `card` (the dashboard permission plus the card's own, ops spec 7). */
export function canSeeCard(actor: Actor, card: CardDef): boolean {
  return holdsAny(actor, ...DASHBOARD_PERMISSIONS) && (card.anyOf === null || holdsAny(actor, ...card.anyOf));
}

type RawRow = { person_id: string | null; ref_type: string; ref_id: string; params: Record<string, unknown> | string; name: string | null; total: string | number };

/** Count and the first `limit` rows of one card. */
export async function loadCard(db: DbOrTx, card: CardDef, env: CardEnv, limit: number): Promise<ActionCard> {
  const sqlCard = () => loadSqlCard(db, card, env, limit);
  return card.load ? card.load(db, env, limit, sqlCard) : sqlCard();
}

async function loadSqlCard(db: DbOrTx, card: CardDef, env: CardEnv, limit: number): Promise<ActionCard> {
  const { base, order } = card.query(env);
  const raw = rowsOf<RawRow>(
    await db.execute(sql`select b.person_id, b.ref_type, b.ref_id, b.params, count(*) over () as total,
        nullif(trim(concat_ws(' ', pe.first_name, pe.last_name)), '') as name
      from (${base}) b left join persons pe on pe.id = b.person_id
      order by ${order} limit ${limit}`),
  );
  return {
    key: card.key,
    count: raw.length ? Number(raw[0]!.total) : 0,
    rows: raw.map((r) => {
      const params = (typeof r.params === "string" ? JSON.parse(r.params) : r.params) as Record<string, unknown>;
      return {
        personId: r.person_id,
        name: r.name ?? (typeof params.title === "string" ? params.title : null),
        refType: r.ref_type,
        refId: String(r.ref_id),
        params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, normalise(v)])),
      };
    }),
    canCreateTask: card.createsTasks && holdsAny(env.actor, "tasks.all"),
  };
}

// ---------------------------------------------------------------------------------------------
// R2 cards over other modules' api (rules 29 and 31)
// ---------------------------------------------------------------------------------------------

const isStub = (e: unknown) => e instanceof NotImplementedError || (e as { name?: string } | null)?.name === "NotImplementedError";

/** Display names of `personIds` (staff screen). */
async function namesOf(db: DbOrTx, personIds: string[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(personIds)];
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: persons.id, name: sql<string | null>`nullif(trim(concat_ws(' ', ${persons.firstName}, ${persons.lastName})), '')` })
    .from(persons)
    .where(inArray(persons.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * Rule 29 from R2: the native count and first rows from webinar's api (registrations of webinars
 * started since `now - (webinar_lead_window_days + add)` days), the imported registrations as the
 * second figure. While webinar's functions are not implemented, the card stays the V1 card.
 */
async function loadWebinarLeads(db: DbOrTx, env: CardEnv, limit: number, sqlCard: () => Promise<ActionCard>): Promise<ActionCard> {
  const imported = await sqlCard();
  const startedSince = new Date(env.now.getTime() - (env.cfg.webinar_lead_window_days + env.add) * 86_400_000);
  let count: number;
  let native: Awaited<ReturnType<typeof listWebinarLeadsWithoutBooking>>;
  try {
    count = await countWebinarLeadsWithoutBooking(db, { startedSince });
    native = await listWebinarLeadsWithoutBooking(db, { startedSince, limit });
  } catch (error) {
    if (isStub(error)) return imported;
    throw error;
  }
  const names = await namesOf(db, native.map((r) => r.personId));
  const rows: ActionCardRow[] = native.slice(0, limit).map((r) => ({
    personId: r.personId,
    name: names.get(r.personId) ?? null,
    refType: "webinar",
    refId: r.webinarId,
    params: { date: new Date(r.registeredAt).toISOString() },
  }));
  return { ...imported, count, rows: [...rows, ...imported.rows].slice(0, limit), secondary: { key: "imported", count: imported.count } };
}

/** Waitlist entries flagged as duplicates (rule 31), as card rows. */
const FLAGGED_WAITLIST = sql`select w.person_id, 'waitlist_entry' as ref_type, w.id::text as ref_id, extract(epoch from w.created_at)::numeric as sort1,
    jsonb_build_object('date', w.created_at) as params
  from waitlist_entries w join persons pe on pe.id = w.person_id
  where w.is_flagged_duplicate and w.state in ('waiting', 'offered') and pe.is_tester = false`;

/** Credits' review screen of rule 31. */
export const SHARING_REVIEW_HREF = "/admin/credits/sharing-review";

/** Rule 31: credits' `countSharingReviewItems` plus the flagged waitlist entries; credits' rows first. */
async function loadSharedPackageAbuse(db: DbOrTx, _env: CardEnv, limit: number, sqlCard: () => Promise<ActionCard>): Promise<ActionCard> {
  const waitlist = await sqlCard();
  const [reviewCount, review] = [await countSharingReviewItems(db), await listSharingReview(db, { limit })];
  const grantIds = review.flatMap((r) => (r.rule === "many_guests" && r.grantId ? [r.grantId] : []));
  const owners = new Map<string, string>();
  if (grantIds.length) {
    const rows = await db.select({ id: creditGrants.id, personId: creditGrants.personId }).from(creditGrants).where(inArray(creditGrants.id, grantIds));
    for (const r of rows) owners.set(r.id, r.personId);
  }
  const reviewRows = review.map((r) => {
    const personId = r.rule === "many_guests" ? (r.grantId ? (owners.get(r.grantId) ?? null) : null) : r.guestPersonId;
    return {
      personId,
      refType: r.rule === "many_guests" ? "credit_grant" : "person",
      refId: (r.rule === "many_guests" ? r.grantId : r.guestPersonId) ?? "",
      params: { guests: r.distinctCount, rule: r.rule, date: new Date(r.lastAt).toISOString() },
    };
  });
  const names = await namesOf(db, reviewRows.flatMap((r) => (r.personId ? [r.personId] : [])));
  return {
    ...waitlist,
    count: reviewCount + waitlist.count,
    rows: [...reviewRows.map((r) => ({ ...r, name: r.personId ? (names.get(r.personId) ?? null) : null })), ...waitlist.rows].slice(0, limit),
    linkHref: SHARING_REVIEW_HREF,
  };
}

function normalise(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object" && "en" in v) return String((v as Record<string, unknown>).en);
  if (typeof v === "object") return JSON.stringify(v);
  return typeof v === "boolean" || typeof v === "bigint" ? String(v) : null;
}

// ---------------------------------------------------------------------------------------------
// Rule 22a: "Create task" on a card row
// ---------------------------------------------------------------------------------------------

/** Task kind per card (rule 22a). */
export function taskKindFor(card: ActionCardKey): TaskKind {
  if (card === "failed_payments") return "payment";
  if (card === "b2b_proposals") return "proposal";
  if (card === "shared_package_abuse") return "review";
  return "follow_up";
}

/** `retention` for the retention-reason cards, `manual` for the others (rule 22a). */
export function taskSourceFor(card: ActionCardKey): "retention" | "manual" {
  return CARD_BY_KEY.get(card)?.reason ? "retention" : "manual";
}

/** The task title in `locale`: the reason's `ops.retention.task_title.<reason>`, else the card title. */
export function taskTitleFor(card: ActionCardKey, locale: Locale): string {
  const reason = CARD_BY_KEY.get(card)?.reason;
  return t(locale, reason ? `ops.retention.task_title.${reason}` : `ops.dashboard.card.${card}.title`);
}

/** Booking's closed-day exceptions for every template (`closed`, `holiday`) from the Brussels date of `at` for a year. */
export async function closedDaysFrom(db: DbOrTx, at: Date): Promise<string[]> {
  const from = brusselsDate(at);
  const to = brusselsDate(new Date(at.getTime() + 367 * 86_400_000));
  const rows = await db
    .select({ onDate: sessionExceptions.onDate })
    .from(sessionExceptions)
    .where(and(inArray(sessionExceptions.kind, ["closed", "holiday"]), isNull(sessionExceptions.templateIds), gte(sessionExceptions.onDate, from), lte(sessionExceptions.onDate, to)));
  return rows.map((r) => String(r.onDate).slice(0, 10));
}

/** 10:00 Brussels on the next business day after `at` (booking's hours and closed days, Belgian holidays). */
export async function taskDueAt(db: DbOrTx, at: Date): Promise<Date> {
  let hours = DEFAULT_BUSINESS_HOURS;
  try {
    hours = await getSetting(db, "business_hours");
  } catch {
    // no row and no registry default in a bare test database: booking's default hours
  }
  return nextBusinessDay(at, hours, await closedDaysFrom(db, at));
}

export type CreateCardTaskInput = { card: ActionCardKey; personId: string; refType?: string; refId?: string; ownerUserId?: string };

/**
 * Rule 22a. Locks the person `for update`, returns the open task of this card and row when one
 * exists, else creates one through crm's `createTask` with the dedupe key
 * `card:<card>:<personId>:<refId>` (a row without its own reference uses the person id).
 */
export async function createCardTask(tx: Tx, ctx: EventCtx, input: CreateCardTaskInput): Promise<{ taskId: string; created: boolean }> {
  const card = CARD_BY_KEY.get(input.card);
  if (card && !card.createsTasks) throw new ValidationError("validation", { card: "no_tasks" });
  const [person] = await tx.select({ id: persons.id }).from(persons).where(and(eq(persons.id, input.personId), isNull(persons.erasedAt))).for("update");
  if (!person) throw new NotFoundError("person");
  const refId = input.refId ?? input.personId;
  const refType = `action_card:${input.card}`;
  const [open] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.personId, input.personId), eq(tasks.refType, refType), eq(tasks.refId, refId), eq(tasks.status, "open")))
    .limit(1);
  if (open) return { taskId: open.id, created: false };

  const ownerUserId = input.ownerUserId ?? (ctx.actor.kind === "staff" ? ctx.actor.userId : undefined);
  let locale: Locale = "nl-BE";
  if (ownerUserId) {
    const [owner] = await tx.select({ locale: users.locale }).from(users).where(eq(users.id, ownerUserId));
    if (!owner) throw new ValidationError("validation", { ownerUserId: "not_found" });
    locale = owner.locale;
  }
  return createTask(tx, ctx, {
    title: taskTitleFor(input.card, locale),
    kind: taskKindFor(input.card),
    ...(ownerUserId ? { ownerUserId } : {}),
    personId: input.personId,
    dueAt: await taskDueAt(tx, ctx.now),
    priority: "normal",
    source: taskSourceFor(input.card),
    ref: { type: refType, id: refId },
    dedupeKey: `card:${input.card}:${input.personId}:${refId}`,
  });
}
