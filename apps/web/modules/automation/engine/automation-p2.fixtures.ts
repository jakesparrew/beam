/**
 * Test fixtures for the automation engine suites (automation-P2): groups, published automations
 * and activity events. Imported by the `*.test.ts` files of this module only.
 */
import { randomUUID } from "node:crypto";
import type { Db, Tx } from "@beam/db";
import { activityEvents, automationGroups, automations, automationVersions } from "@beam/db/schema";
import type { AutomationPurpose, Definition, EventView } from "@beam/core/automation";
import { eq, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { makeCtx } from "@/lib/testing";
import { evaluateBatch, type EvaluateResult } from "./evaluate";

let n = 0;
const uniq = () => `${(++n).toString(36)}${randomUUID().slice(0, 4).replace(/[^a-z0-9]/g, "a")}`;

export type GroupRow = typeof automationGroups.$inferSelect;
export type AutomationRow = typeof automations.$inferSelect;

export async function makeGroup(db: Db, over: Partial<typeof automationGroups.$inferInsert> = {}): Promise<GroupRow> {
  const key = over.key ?? `g_${uniq()}`.replace(/-/g, "_");
  const [row] = await db.insert(automationGroups).values({ key, name: key, ...over }).returning();
  return row!;
}

/** A minimal valid definition: event trigger, anchor enrolment, one tag step at +60 min. */
export function def(over: Partial<Definition> = {}): Definition {
  return {
    schema_version: 1,
    trigger: { event: "test.happened" },
    anchor: "enrolment",
    re_entry: "always",
    exit_on: [],
    steps: [{ key: "s1", type: "tag", tag: "engaged", at: { from: "enrolment", minutes: 60 } }],
    ...over,
  };
}

export type MakeAutomation = {
  slug?: string;
  definition?: Definition;
  group?: GroupRow;
  status?: "draft" | "active" | "paused" | "archived";
  isMarketing?: boolean;
  purpose?: AutomationPurpose | null;
  priority?: number;
  requiresDpia?: string | null;
  requiresFlag?: string | null;
  draftDefinition?: unknown;
  /** Publish no version (a draft without one). */
  unpublished?: boolean;
};

/** An automation with a published version 1 (marketing `newsletter` by default, status `active`). */
export async function makeAutomation(db: Db, o: MakeAutomation = {}): Promise<AutomationRow & { versionId: string | null }> {
  const group = o.group ?? (await makeGroup(db));
  const isMarketing = o.isMarketing ?? true;
  const [a] = await db
    .insert(automations)
    .values({
      slug: o.slug ?? `auto-${uniq()}`,
      name: o.slug ?? "Test automation",
      groupId: group.id,
      priority: o.priority ?? 100,
      isMarketing,
      purpose: o.purpose === undefined ? (isMarketing ? "newsletter" : null) : o.purpose,
      requiresDpia: o.requiresDpia ?? null,
      requiresFlag: o.requiresFlag ?? null,
      draftDefinition: o.draftDefinition ?? null,
    })
    .returning();
  if (o.unpublished) return { ...a!, versionId: null };
  const definition = o.definition ?? def();
  const [v] = await db
    .insert(automationVersions)
    .values({ automationId: a!.id, version: 1, definition, definitionHash: randomUUID() })
    .returning();
  const status = o.status ?? "active";
  const [updated] = await db
    .update(automations)
    .set({ currentVersionId: v!.id, status, pausedAt: status === "paused" ? new Date() : null })
    .where(eq(automations.id, a!.id))
    .returning();
  return { ...updated!, versionId: v!.id };
}

export type MakeEvent = {
  personId: string;
  kind: string;
  data?: Record<string, unknown>;
  occurredAt?: Date;
  refType?: string | null;
  refId?: string | null;
  mode?: "live" | "replay" | "on_demand" | null;
  isSensitive?: boolean;
  /** An explicit id (`overriding system value`), to simulate out-of-order commits. */
  id?: bigint;
};

/** Inserts an `activity_events` row and returns it as the engine's `EventView`. */
export async function makeEvent(db: Db | Tx, e: MakeEvent): Promise<EventView> {
  const occurredAt = e.occurredAt ?? new Date();
  const data = e.data ?? {};
  if (e.id !== undefined) {
    await db.execute(sql`insert into activity_events (id, person_id, kind, occurred_at, mode, is_sensitive, actor, ref_type, ref_id, data)
      overriding system value values (${e.id.toString()}::bigint, ${e.personId}, ${e.kind}, ${occurredAt}, ${e.mode ?? null}, ${e.isSensitive ?? false},
      ${JSON.stringify({ kind: "system", id: null })}::jsonb, ${e.refType ?? null}, ${e.refId ?? null}, ${JSON.stringify(data)}::jsonb)`);
    return { id: e.id, kind: e.kind, personId: e.personId, occurredAt, mode: e.mode ?? null, refType: e.refType ?? null, refId: e.refId ?? null, isSensitive: e.isSensitive ?? false, data };
  }
  const [row] = await db
    .insert(activityEvents)
    .values({
      personId: e.personId,
      kind: e.kind,
      occurredAt,
      mode: e.mode ?? null,
      isSensitive: e.isSensitive ?? false,
      actor: { kind: "system", id: null },
      refType: e.refType ?? null,
      refId: e.refId ?? null,
      data,
    })
    .returning({ id: activityEvents.id });
  return { id: row!.id, kind: e.kind, personId: e.personId, occurredAt, mode: e.mode ?? null, refType: e.refType ?? null, refId: e.refId ?? null, isSensitive: e.isSensitive ?? false, data };
}

/** The highest event id so far (a cursor start for tests that share one database). */
export async function maxEventId(db: Db): Promise<bigint> {
  const [r] = rowsOf<{ m: string | null }>(await db.execute(sql`select max(id)::text as m from activity_events`));
  return BigInt(r?.m ?? "0");
}

/** Moves the cursor to `id` (no gaps), so a test only sees its own events. */
export async function setCursor(db: Db, id: bigint, gaps: { id: string; first_seen_at: string }[] = []): Promise<void> {
  await db.execute(sql`insert into settings (key, value) values ('automation_cursor', ${JSON.stringify({ last_event_id: id.toString(), gaps })}::jsonb)
    on conflict (key) do update set value = excluded.value`);
}

/** One evaluator pass on the test database with a system context at `now`. */
export function evaluate(db: Db, now = new Date(), opts: { maxEvents?: number; pageSize?: number } = {}): Promise<EvaluateResult> {
  const ctx = makeCtx(db, { now });
  return evaluateBatch(db as unknown as Tx, now, { ctx, ...opts });
}

/** Deletes every automation row (between tests that need an empty engine). */
export async function resetAutomations(db: Db): Promise<void> {
  await db.execute(sql`set beam.allow_rewrite = 'on'`);
  await db.execute(sql`delete from automation_runs`);
  await db.execute(sql`delete from automation_enrolments`);
  await db.execute(sql`update automations set current_version_id = null, status = 'draft', paused_at = null`);
  await db.execute(sql`delete from automation_versions`);
  await db.execute(sql`delete from automations`);
  await db.execute(sql`set beam.allow_rewrite = 'off'`);
}
