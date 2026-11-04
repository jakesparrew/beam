"use server";
/**
 * ops server actions, area `exports` (ops spec 4.1, ops-P6): createExport, updateRetentionPolicy,
 * updateDpiaRecord. Every action goes through `action()` with its Zod input from `@beam/core/ops`.
 *
 * - `createExport` (`persons.export`; a full export also `users.manage`, invoices, payments and
 *   refunds also `invoices.read`) inserts a `queued` export and enqueues its first chunk. The
 *   audit row `data.exported` is written once by the finalise job, with the row count (rule 57).
 * - `updateRetentionPolicy` (`privacy.run`) changes `days` or `is_active`; a `keep` policy has
 *   no days and accounting-linked keys never go below 3653 days. Audit `retention_policy.updated`.
 * - `updateDpiaRecord` (`settings.write`) sets status and texts; `approved` and `not_required`
 *   need a decision note (rule 70). Audit `dpia.updated` with old and new values.
 */
import { dataExports, dpiaRecords, files, retentionPolicies } from "@beam/db/schema";
import { ForbiddenError } from "@beam/core/errors";
import { CreateExportInput, FINANCE_EXPORT_ENTITIES, UpdateDpiaRecordInput, UpdateRetentionPolicyInput, type ExportEntity } from "@beam/core/ops";
import { action } from "@/lib/action";
import { eq, NotFoundError, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { ENTITY_EXPORTS, fullExportTables } from "./entities";
import { ACCOUNTING_KEYS, ACCOUNTING_MIN_DAYS, chunkKey, emptyCursor } from "./jobs";

function staffUserId(ctx: Ctx): string {
  if (ctx.actor.kind !== "staff") throw new ForbiddenError("forbidden: staff");
  return ctx.actor.userId;
}

/** Rules 54-56: a new export; the chunk jobs write the parts. */
export const createExport = action(
  { name: "ops.export_create", audience: "staff", permission: "persons.export", input: CreateExportInput, audit: false },
  async (ctx, input): Promise<{ exportId: string }> => {
    const userId = staffUserId(ctx);
    if (input.kind === "full") ctx.require("users.manage");
    const entity = input.kind === "entity" ? (input.entity as ExportEntity) : null;
    if (entity && (FINANCE_EXPORT_ENTITIES as readonly string[]).includes(entity)) ctx.require("invoices.read");
    const filters = input.kind === "entity" ? (input.filters ?? {}) : {};
    if (filters.from && filters.to && filters.from > filters.to) throw new ValidationError("from_after_to", { to: "before_from" });
    if (filters.segmentId && entity && !ENTITY_EXPORTS[entity].person) throw new ValidationError("segment_not_applicable", { segmentId: "not_applicable" });
    const tables = input.kind === "full" ? await fullExportTables(ctx.tx) : undefined;
    const [row] = await ctx.tx
      .insert(dataExports)
      .values({ kind: input.kind, entity, filters, status: "queued", createdByUserId: userId, cursor: emptyCursor(tables) })
      .returning({ id: dataExports.id });
    const exportId = row!.id;
    const first = entity ?? tables![0]!;
    await ctx.enqueue({ kind: "ops.export_chunk", payload: { exportId, entity: first, offset: 0 }, key: chunkKey(exportId, first, 0) });
    return { exportId };
  },
);

/** Staff edit of a retention period or its switch (section 9: re-seeding never overwrites it). */
export const updateRetentionPolicy = action(
  { name: "ops.retention_policy_update", audience: "staff", permission: "privacy.run", input: UpdateRetentionPolicyInput, audit: false },
  async (ctx, input): Promise<{ ok: true }> => {
    const userId = staffUserId(ctx);
    await ctx.tx.execute(sql`select id from retention_policies where key = ${input.key} for update`);
    const [policy] = await ctx.tx.select().from(retentionPolicies).where(eq(retentionPolicies.key, input.key));
    if (!policy) throw new NotFoundError("retention_policy_not_found");
    if (input.days === undefined && input.isActive === undefined) throw new ValidationError("nothing_to_change", { days: "required" });
    if (input.days !== undefined && policy.action === "keep") throw new ValidationError("keep_has_no_days", { days: "not_applicable" });
    if (input.days !== undefined && (ACCOUNTING_KEYS as readonly string[]).includes(policy.key) && input.days < ACCOUNTING_MIN_DAYS) {
      throw new ValidationError("accounting_minimum", { days: "min_3653" });
    }
    const next = { days: input.days ?? policy.days, isActive: input.isActive ?? policy.isActive };
    await ctx.tx
      .update(retentionPolicies)
      .set({ ...next, updatedByUserId: userId, updatedAt: ctx.now })
      .where(eq(retentionPolicies.id, policy.id));
    await ctx.audit({
      action: "retention_policy.updated",
      entityType: "retention_policy",
      entityId: policy.id,
      oldValue: { key: policy.key, days: policy.days, isActive: policy.isActive },
      newValue: { key: policy.key, ...next },
    });
    return { ok: true };
  },
);

/** Rule 70: one DPIA record; every change is audited. */
export const updateDpiaRecord = action(
  { name: "ops.dpia_update", audience: "staff", permission: "settings.write", input: UpdateDpiaRecordInput, audit: false },
  async (ctx, input): Promise<{ ok: true }> => {
    const userId = staffUserId(ctx);
    if (input.documentFileId) {
      const [file] = await ctx.tx.select({ id: files.id }).from(files).where(eq(files.id, input.documentFileId));
      if (!file) throw new ValidationError("document_not_found", { documentFileId: "not_found" });
    }
    await ctx.tx.insert(dpiaRecords).values({ key: input.key }).onConflictDoNothing({ target: dpiaRecords.key });
    await ctx.tx.execute(sql`select id from dpia_records where key = ${input.key} for update`);
    const [old] = await ctx.tx.select().from(dpiaRecords).where(eq(dpiaRecords.key, input.key));
    const text = (v: string | undefined, current: string | null) => (v === undefined ? current : v.trim() || null);
    const next = {
      status: input.status,
      purpose: text(input.purpose, old!.purpose),
      risks: text(input.risks, old!.risks),
      measures: text(input.measures, old!.measures),
      decisionNote: text(input.decisionNote, old!.decisionNote),
      documentFileId: input.documentFileId ?? old!.documentFileId,
    };
    if ((next.status === "approved" || next.status === "not_required") && !next.decisionNote) {
      throw new ValidationError("decision_note_required", { decisionNote: "required" });
    }
    await ctx.tx
      .update(dpiaRecords)
      .set({ ...next, reviewedByUserId: userId, reviewedAt: ctx.now, updatedAt: ctx.now })
      .where(eq(dpiaRecords.id, old!.id));
    const pick = (r: typeof next) => ({ status: r.status, purpose: r.purpose, risks: r.risks, measures: r.measures, decisionNote: r.decisionNote, documentFileId: r.documentFileId });
    await ctx.audit({ action: "dpia.updated", entityType: "dpia_record", entityId: old!.id, oldValue: { key: input.key, ...pick(old!) }, newValue: { key: input.key, ...pick(next) } });
    return { ok: true };
  },
);
