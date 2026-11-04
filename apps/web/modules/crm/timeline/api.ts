/**
 * Timeline api (crm rules 3.35 to 3.37, spec 4.7), crm-P7. Lists the `activity_events` of a
 * person (every id of `resolvePersonIds`, so a merged loser's history is included) or of a
 * company, newest first by `(occurred_at, id)`, merged by time with automation's run items
 * (`getTimelineItems`; automation writes no `activity_events`, its rule A-7).
 *
 * Order and cursor: items sort by the millisecond of `occurred_at` (a JS `Date` carries no
 * microseconds, so the cursor would otherwise skip rows), then events before automation items,
 * then the event id (numeric) or the run id. An event's `id` is its numeric id as text, an
 * automation item's is `automation:<run id>`; `nextBefore` is the last item's `{ occurredAt, id }`.
 * A sensitive note is returned without its ciphertext: `data = {}` and `isSensitive = true`.
 * The row's `mode` column (live, replay, on demand; rule 3.36) is copied into `data.mode`.
 */
import type { DbOrTx } from "@beam/db";
import { TIMELINE_CATEGORIES, type TimelineCategory, type TimelineItem, type TimelinePage } from "@beam/core/crm";
import { sql, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { getTimelineItems } from "@/modules/automation/api";
import { resolvePersonIds } from "../persons/api";

/** Kind prefix (before the dot) to category (spec 4.7). A prefix not listed falls into `profile`. */
export const TIMELINE_PREFIX_CATEGORY: Readonly<Record<string, TimelineCategory>> = {
  person: "profile",
  tag: "profile",
  segment: "profile",
  sensitive: "profile",
  declaration: "profile",
  ops: "profile",
  booking: "bookings",
  waitlist: "bookings",
  checkout: "purchases",
  order: "purchases",
  payment: "purchases",
  refund: "purchases",
  promotion: "purchases",
  pos: "purchases",
  invoice: "purchases",
  credit_note: "purchases",
  credits: "purchases",
  membership: "purchases",
  referral: "purchases",
  email: "email",
  webinar: "webinar",
  form: "forms",
  assessment: "forms",
  note: "service",
  interaction: "service",
  task: "service",
  inbox: "service",
  consent: "consent",
  suppression: "consent",
  privacy: "consent",
  company: "b2b",
  opportunity: "b2b",
};

/** The category of an event kind (`automation` is only used for automation items). */
export function categoryOfKind(kind: string): TimelineCategory {
  const prefix = kind.split(".")[0] ?? "";
  return TIMELINE_PREFIX_CATEGORY[prefix] ?? "profile";
}

export const AUTOMATION_ITEM_PREFIX = "automation:";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type ListInput = {
  personId?: string;
  companyId?: string;
  before?: { occurredAt: Date; id: string };
  categories?: TimelineCategory[];
  limit?: number;
};

type EventRow = {
  id: string | number | bigint;
  occurred_ms: Date | string;
  kind: string;
  person_id: string | null;
  company_id: string | null;
  data: Record<string, unknown> | null;
  is_sensitive: boolean;
  mode: string | null;
};

const truncMs = (d: Date) => new Date(Math.floor(d.getTime()));

/** `-1` when `a` sorts before `b` (newer first), `1` after. */
export function compareTimelineItems(a: { occurredAt: Date; id: string }, b: { occurredAt: Date; id: string }): number {
  const ta = a.occurredAt.getTime();
  const tb = b.occurredAt.getTime();
  if (ta !== tb) return tb - ta;
  const aAuto = a.id.startsWith(AUTOMATION_ITEM_PREFIX);
  const bAuto = b.id.startsWith(AUTOMATION_ITEM_PREFIX);
  if (aAuto !== bAuto) return aAuto ? 1 : -1;
  if (!aAuto) {
    const na = BigInt(a.id);
    const nb = BigInt(b.id);
    return na === nb ? 0 : na > nb ? -1 : 1;
  }
  return a.id === b.id ? 0 : a.id > b.id ? -1 : 1;
}

function categoryFilter(categories: readonly TimelineCategory[] | undefined): SQL | null {
  if (!categories?.length) return null;
  const wanted = new Set(categories);
  const prefixes = Object.entries(TIMELINE_PREFIX_CATEGORY)
    .filter(([, c]) => wanted.has(c))
    .map(([p]) => p);
  const prefix = sql`split_part(kind, '.', 1)`;
  const parts: SQL[] = [];
  if (prefixes.length) parts.push(sql`${prefix} in (${sql.join(prefixes.map((p) => sql`${p}`), sql`, `)})`);
  if (wanted.has("profile")) {
    const mapped = Object.keys(TIMELINE_PREFIX_CATEGORY);
    parts.push(sql`${prefix} not in (${sql.join(mapped.map((p) => sql`${p}`), sql`, `)})`);
  }
  if (!parts.length) return sql`false`;
  return sql`(${sql.join(parts, sql` or `)})`;
}

async function eventItems(tx: DbOrTx, input: ListInput, personIds: string[] | null, limit: number): Promise<TimelineItem[]> {
  const conds: SQL[] = [];
  if (personIds) conds.push(sql`person_id in (${sql.join(personIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  else conds.push(sql`company_id = ${input.companyId!}::uuid`);
  const ms = sql`date_trunc('milliseconds', occurred_at)`;
  if (input.before) {
    const at = truncMs(input.before.occurredAt).toISOString();
    if (input.before.id.startsWith(AUTOMATION_ITEM_PREFIX)) conds.push(sql`${ms} < ${at}::timestamptz`);
    else conds.push(sql`(${ms} < ${at}::timestamptz or (${ms} = ${at}::timestamptz and id < ${input.before.id}::bigint))`);
  }
  const cat = categoryFilter(input.categories);
  if (cat) conds.push(cat);
  const rows = rowsOf<EventRow>(
    await tx.execute(sql`
      select id::text as id, ${ms} as occurred_ms, kind, person_id, company_id, data, is_sensitive, mode::text as mode
      from activity_events
      where ${sql.join(conds, sql` and `)}
      order by ${ms} desc, id desc
      limit ${limit}`),
  );
  return rows.map((r) => ({
    id: String(r.id),
    occurredAt: new Date(r.occurred_ms),
    kind: r.kind,
    category: categoryOfKind(r.kind),
    personId: r.person_id,
    companyId: r.company_id,
    data: r.is_sensitive ? {} : { ...(r.data ?? {}), ...(r.mode ? { mode: r.mode } : {}) },
    isSensitive: r.is_sensitive,
  }));
}

async function automationItems(tx: DbOrTx, input: ListInput, personIds: string[], limit: number): Promise<TimelineItem[]> {
  if (input.categories?.length && !input.categories.includes("automation")) return [];
  // automation filters `occurred_at < before`; ask for one millisecond more and cut here.
  const before = input.before ? new Date(truncMs(input.before.occurredAt).getTime() + 1) : undefined;
  const lists = await Promise.all(personIds.map((id) => getTimelineItems(tx, id, { ...(before ? { before } : {}), limit: Math.min(limit + 50, 500) })));
  const items: TimelineItem[] = [];
  personIds.forEach((personId, i) => {
    for (const a of lists[i] ?? []) {
      items.push({
        id: `${AUTOMATION_ITEM_PREFIX}${a.id}`,
        occurredAt: truncMs(new Date(a.occurredAt)),
        kind: `automation.${a.outcome}`,
        category: "automation",
        personId,
        companyId: null,
        data: {
          automation_slug: a.automationSlug,
          automation_name: a.automationName,
          step_key: a.stepKey,
          outcome: a.outcome,
          reason: a.reason,
          end_reason: a.endReason,
          email_status: a.emailStatus,
          task_id: a.taskId,
        },
        isSensitive: false,
      });
    }
  });
  const cursor = input.before;
  return cursor ? items.filter((it) => compareTimelineItems(it, { occurredAt: truncMs(cursor.occurredAt), id: cursor.id }) > 0) : items;
}

/**
 * Rule 3.37: one page of the timeline (default 50, at most 200), with an optional category
 * filter. Exactly one of `personId` and `companyId` is required.
 */
export async function listTimeline(tx: DbOrTx, input: ListInput): Promise<TimelinePage> {
  if (!input.personId === !input.companyId) throw new RangeError("listTimeline needs exactly one of personId and companyId");
  if (input.before && !input.before.id.startsWith(AUTOMATION_ITEM_PREFIX) && !/^[0-9]+$/.test(input.before.id)) throw new RangeError("invalid timeline cursor");
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const personIds = input.personId ? await resolvePersonIds(tx, input.personId) : null;
  const [events, autos] = await Promise.all([
    eventItems(tx, input, personIds, limit + 1),
    personIds ? automationItems(tx, input, personIds, limit + 1) : Promise.resolve([] as TimelineItem[]),
  ]);
  const merged = [...events, ...autos].sort(compareTimelineItems);
  const page = merged.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page, nextBefore: merged.length > limit && last ? { occurredAt: last.occurredAt, id: last.id } : null };
}

/** Every category the timeline offers as a chip, in display order. */
export const TIMELINE_CHIPS: readonly TimelineCategory[] = TIMELINE_CATEGORIES;
