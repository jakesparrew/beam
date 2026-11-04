"use server";
/**
 * Segment actions (crm spec 4.1; rules 3.38 to 3.41), crm-P5. Segments are edited with
 * `email.write` (decision 24). Saving validates the rule against the allow-lists, refuses
 * `in_segment` cycles and unknown references, and refreshes inline when at most 20,000 persons
 * exist (else it enqueues `segments.refresh_one`). Archiving refuses a segment that a campaign,
 * an automation or another segment still uses (cross-module D61).
 */
import { z } from "zod";
import { segmentMembers, segments } from "@beam/db/schema";
import { hasSegmentCycle, referencedSegmentIds, SegmentRuleSchema, validateSegmentRule, type SegmentRule } from "@beam/core/crm";
import { NotImplementedError } from "@beam/core/errors";
import { action } from "@/lib/action";
import { and, ConflictError, eq, inArray, NotFoundError, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { isSegmentInUse as automationUsesSegment } from "@/modules/automation/api";
import { isSegmentInUse as emailUsesSegment } from "@/modules/email/api";
import { searchPersons } from "../persons/api";
import { countAudience, refreshSegmentInTx, writeMembershipEvents } from "./api";
import { findPersonIdsByCustomerNumbers, previewSegment } from "./queries";
import { uuidArray } from "./sql";

/** Above this many persons a save enqueues the refresh instead of running it inline. */
const INLINE_REFRESH_MAX_PERSONS = 20_000;

const SaveInput = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(1000).optional(),
  kind: z.enum(["dynamic", "static"]),
  definition: SegmentRuleSchema,
  excludeSegmentIds: z.array(z.uuid()).max(20),
});

/** Validation of the rule, the references and the exclusions; throws `ValidationError` with rule paths. */
async function checkDefinition(ctx: Ctx, id: string | undefined, definition: SegmentRule, excludeIds: readonly string[]): Promise<void> {
  const checked = validateSegmentRule(definition);
  if (!checked.ok) throw new ValidationError("invalid_segment_rule", checked.issues);
  const refs = referencedSegmentIds(definition);
  const named = [...new Set([...refs, ...excludeIds])];
  const fields: Record<string, string> = {};
  if (id && excludeIds.includes(id)) fields.excludeSegmentIds = "self_exclusion";
  if (named.length) {
    const rows = rowsOf<{ id: string; is_archived: boolean }>(await ctx.tx.execute(sql`select id, is_archived from segments where id = any(${uuidArray(named)})`));
    const known = new Map(rows.map((r) => [r.id, r.is_archived]));
    for (const ref of refs) if (!known.has(ref)) fields[`definition.in_segment.${ref}`] = "unknown_segment";
    for (const ex of excludeIds) if (!known.has(ex) && ex !== id) fields.excludeSegmentIds = "unknown_segment";
  }
  if (Object.keys(fields).length) throw new ValidationError("invalid_segment_reference", fields);
  if (id && refs.length) {
    const all = await ctx.tx.select({ id: segments.id, definition: segments.definition }).from(segments);
    const graph = Object.fromEntries(all.filter((s) => s.id !== id).map((s) => [s.id, referencedSegmentIds(s.definition as SegmentRule)]));
    if (hasSegmentCycle(id, refs, graph)) throw new ValidationError("segment_cycle", { definition: "segment_cycle" });
  }
}

async function activePersonCount(ctx: Ctx): Promise<number> {
  const [row] = rowsOf<{ n: number | string }>(
    await ctx.tx.execute(sql`select count(*)::int as n from persons where erased_at is null and merged_into_person_id is null`),
  );
  return Number(row?.n ?? 0);
}

export const saveSegment = action(
  { name: "crm.save_segment", audience: "staff", permission: "email.write", input: SaveInput, audit: false },
  async (ctx, input): Promise<{ id: string; count: number | null }> => {
    const excludeIds = [...new Set(input.excludeSegmentIds)];
    await checkDefinition(ctx, input.id, input.definition, excludeIds);
    const values = {
      name: input.name,
      description: input.description?.trim() || null,
      kind: input.kind,
      definition: input.definition as Record<string, unknown>,
      excludeSegmentIds: excludeIds,
    };
    let id = input.id;
    let old: Record<string, unknown> | null = null;
    if (id) {
      const [row] = await ctx.tx.select().from(segments).where(eq(segments.id, id)).for("update");
      if (!row) throw new NotFoundError("segment_not_found");
      if (row.isArchived) throw new ConflictError("segment_archived");
      old = { name: row.name, description: row.description, kind: row.kind, definition: row.definition, excludeSegmentIds: row.excludeSegmentIds };
      await ctx.tx.update(segments).set(values).where(eq(segments.id, id));
    } else {
      const createdBy = ctx.actor.kind === "staff" ? ctx.actor.userId : null;
      const [row] = await ctx.tx.insert(segments).values({ ...values, createdByUserId: createdBy }).returning({ id: segments.id });
      id = row!.id;
    }
    await ctx.audit({ action: "segment.save", entityType: "segment", entityId: id, oldValue: old, newValue: values });

    if (input.kind === "dynamic" && (await activePersonCount(ctx)) > INLINE_REFRESH_MAX_PERSONS) {
      await ctx.enqueue({ kind: "segments.refresh_one", payload: { segmentId: id, reason: "save" }, key: `segment:${id}:refresh:save:${ctx.requestId}` });
      return { id, count: null };
    }
    const result = await refreshSegmentInTx(ctx.tx, ctx, id, "save");
    return { id, count: result.count };
  },
);

/** email-P6 and automation stubs that are not implemented yet count as "not in use" (crm-P5 spec). */
async function inUse(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return await check();
  } catch (error) {
    if (error instanceof NotImplementedError) return false;
    throw error;
  }
}

export const archiveSegment = action(
  { name: "crm.archive_segment", audience: "staff", permission: "email.write", input: z.object({ id: z.uuid() }), audit: false },
  async (ctx, input): Promise<Record<string, never>> => {
    const [row] = await ctx.tx.select().from(segments).where(eq(segments.id, input.id)).for("update");
    if (!row) throw new NotFoundError("segment_not_found");
    if (row.isArchived) return {};
    if ((await inUse(() => automationUsesSegment(ctx.tx, input.id))) || (await inUse(() => emailUsesSegment(ctx.tx, input.id)))) {
      throw new ConflictError("segment_in_use");
    }
    const others = await ctx.tx.select({ id: segments.id, definition: segments.definition, excludes: segments.excludeSegmentIds }).from(segments).where(eq(segments.isArchived, false));
    const usedBySegment = others.some((s) => s.id !== input.id && (s.excludes.includes(input.id) || referencedSegmentIds(s.definition as SegmentRule).includes(input.id)));
    if (usedBySegment) throw new ConflictError("segment_in_use");
    await ctx.tx.update(segments).set({ isArchived: true }).where(eq(segments.id, input.id));
    await ctx.audit({ action: "segment.archive", entityType: "segment", entityId: input.id, oldValue: { isArchived: false }, newValue: { isArchived: true } });
    return {};
  },
);

export const setStaticMembers = action(
  {
    name: "crm.set_static_members",
    audience: "staff",
    permission: "email.write",
    input: z.object({ segmentId: z.uuid(), add: z.array(z.uuid()).max(5000), remove: z.array(z.uuid()).max(5000) }),
    audit: false,
  },
  async (ctx, input): Promise<{ added: number; removed: number }> => {
    const [row] = await ctx.tx.select().from(segments).where(eq(segments.id, input.segmentId)).for("update");
    if (!row) throw new NotFoundError("segment_not_found");
    if (row.kind !== "static") throw new ConflictError("segment_not_static");
    if (row.isArchived) throw new ConflictError("segment_archived");
    const removeIds = [...new Set(input.remove)];
    const addIds = [...new Set(input.add)].filter((pid) => !removeIds.includes(pid));
    let added: string[] = [];
    if (addIds.length) {
      added = rowsOf<{ person_id: string }>(
        await ctx.tx.execute(sql`
          insert into segment_members (segment_id, person_id, source, computed_at)
          select ${input.segmentId}::uuid, p.id, 'manual', ${ctx.now.toISOString()}::timestamptz
          from persons p where p.id = any(${uuidArray(addIds)}) and p.erased_at is null and p.merged_into_person_id is null
          on conflict (segment_id, person_id) do nothing
          returning person_id`),
      ).map((r) => r.person_id);
    }
    let removed: string[] = [];
    if (removeIds.length) {
      removed = (
        await ctx.tx
          .delete(segmentMembers)
          .where(and(eq(segmentMembers.segmentId, input.segmentId), inArray(segmentMembers.personId, removeIds)))
          .returning({ personId: segmentMembers.personId })
      ).map((r) => r.personId);
    }
    await writeMembershipEvents(ctx.tx, ctx, input.segmentId, "enter", added);
    await writeMembershipEvents(ctx.tx, ctx, input.segmentId, "leave", removed);
    const count = await countAudience(ctx.tx, input.segmentId);
    await ctx.tx.update(segments).set({ lastCount: count, lastCountedAt: ctx.now }).where(eq(segments.id, input.segmentId));
    await ctx.audit({ action: "segment.members", entityType: "segment", entityId: input.segmentId, newValue: { added: added.length, removed: removed.length } });
    return { added: added.length, removed: removed.length };
  },
);

export const refreshSegmentNow = action(
  { name: "crm.refresh_segment", audience: "staff", permission: "email.write", input: z.object({ segmentId: z.uuid() }), audit: false },
  async (ctx, input): Promise<{ jobId: string }> => {
    const [row] = await ctx.tx.select({ id: segments.id }).from(segments).where(eq(segments.id, input.segmentId));
    if (!row) throw new NotFoundError("segment_not_found");
    const job = await ctx.enqueue({
      kind: "segments.refresh_one",
      payload: { segmentId: input.segmentId, reason: "manual" },
      key: `segment:${input.segmentId}:refresh:manual:${ctx.requestId}`,
    });
    return { jobId: job.id };
  },
);

/** The builder's live count and sample (debounced by the client); SQL only for technical admins. */
export const previewSegmentRule = action(
  {
    name: "crm.preview_segment",
    audience: "staff",
    permission: "persons.read",
    input: z.object({ definition: SegmentRuleSchema, excludeIds: z.array(z.uuid()).max(20) }),
    audit: false,
  },
  async (ctx, input) => {
    const checked = validateSegmentRule(input.definition);
    if (!checked.ok) throw new ValidationError("invalid_segment_rule", checked.issues);
    const showSql = ctx.actor.kind === "staff" && ctx.actor.roleKey === "technical_admin";
    return previewSegment(ctx.tx, { definition: checked.rule, excludeIds: input.excludeIds, showSql, now: ctx.now });
  },
);

/** Static member pickers: a name or number search, or a pasted list of customer numbers. */
export const findSegmentPersons = action(
  {
    name: "crm.find_segment_persons",
    audience: "staff",
    permission: "email.write",
    input: z.object({ q: z.string().trim().max(100).optional(), customerNumbers: z.array(z.string().max(30)).max(5000).optional() }),
    audit: false,
  },
  async (ctx, input): Promise<{ persons: Array<{ id: string; customerNumber: string; name: string }>; ids: string[]; unknown: string[] }> => {
    if (input.customerNumbers?.length) {
      const { ids, unknown } = await findPersonIdsByCustomerNumbers(ctx.tx, input.customerNumbers);
      return { persons: [], ids, unknown };
    }
    if (!input.q) return { persons: [], ids: [], unknown: [] };
    const rows = await searchPersons(ctx.tx, { q: input.q, limit: 10 });
    return { persons: rows.map((r) => ({ id: r.personId, customerNumber: r.customerNumber, name: r.name })), ids: [], unknown: [] };
  },
);
