/**
 * Form versions (forms spec section 2 `form_versions`, rules P1 to P9, P13; forms-P2, extended by
 * forms-P3). A published row is IMMUTABLE: every update here filters `published_at is null`, so
 * a published version is never changed. The derived columns (`sensitive_field_keys`,
 * `consent_purposes`, `definition_hash`) are recomputed from the definition on every write.
 *
 * `publishFormVersion` runs the pure publish validation (P1 to P6) and the DPIA gate of rule P7:
 * a version with sensitive fields publishes only while ops' `isDpiaApproved(tx,
 * 'sensitive_assessment_processing')` is true. The only caller allowed to pass
 * `{ skipDpiaCheck: 'demo_seed' }` is the demo seed (`modules/forms/seed.ts`), whose submissions
 * are fake persons on `beam_dev`. `publishVersion` (forms-P3, called by forms-P5's action) adds
 * the other server checks of P7 (CTA targets active, outcome tags exist) through `extraIssues`.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { forms, formVersions, tags, type FormDefinitionJson, type FormScoringJson } from "@beam/db/schema";
import {
  deriveVersionColumns,
  FormDefinition as FormDefinitionSchema,
  FormScoring as FormScoringSchema,
  isPublishable,
  validateForPublish,
  withinSizeLimit,
  type FormDefinition,
  type FormScoring,
  type PublishIssue,
} from "@beam/core/forms";
import type { Locale } from "@beam/core/i18n";
import { and, ConflictError, eq, inArray, isNull, NotFoundError, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { isDpiaApproved } from "@/modules/ops/api";
import { checkCtaTargets, ctaIssues } from "./cta-targets";

/** Publishing refused: `issues` lists every blocking error and the warnings (P1). */
export class PublishRefusedError extends ValidationError {
  override readonly name: string = "PublishRefusedError";
  constructor(readonly issues: PublishIssue[]) {
    super(
      "publish_refused",
      Object.fromEntries(issues.filter((i) => i.level === "error").map((i) => [i.path || i.code, i.code])),
    );
  }
}

export const DPIA_KEY = "sensitive_assessment_processing" as const;

export type VersionContent = { definition: FormDefinition; scoring: FormScoring; locales: Locale[] };

/** The stored row values of a definition plus scoring (F7 size limit enforced). */
export function versionValues(c: VersionContent) {
  if (!withinSizeLimit(c.definition, c.scoring)) throw new ValidationError("limit_exceeded", { definition: "limit_exceeded" });
  return {
    definition: c.definition as unknown as FormDefinitionJson,
    scoring: c.scoring as unknown as FormScoringJson,
    locales: [...c.locales],
    ...deriveVersionColumns(c.definition, c.scoring),
  };
}

/** Reads a version's definition and scoring through the Zod schemas (fills defaults). */
export function parseVersion(row: { definition: unknown; scoring: unknown; locales: string[] }): VersionContent {
  return {
    definition: FormDefinitionSchema.parse(row.definition),
    scoring: FormScoringSchema.parse(row.scoring ?? {}),
    locales: row.locales as Locale[],
  };
}

/** Inserts the editable draft `version` of a form (the partial unique index allows one draft per form). */
export async function insertDraftVersion(
  tx: DbOrTx,
  i: VersionContent & { formId: string; version?: number; createdByUserId: string | null; changeNote?: string | null },
): Promise<{ versionId: string; version: number; definitionHash: string }> {
  const version =
    i.version ??
    Number(
      (await tx.select({ n: sql<number>`coalesce(max(${formVersions.version}), 0)::int` }).from(formVersions).where(eq(formVersions.formId, i.formId)))[0]?.n ?? 0,
    ) + 1;
  const values = versionValues(i);
  const [row] = await tx
    .insert(formVersions)
    .values({ formId: i.formId, version, ...values, changeNote: i.changeNote ?? null, createdByUserId: i.createdByUserId })
    .onConflictDoNothing()
    .returning({ id: formVersions.id });
  if (!row) throw new ConflictError("draft_exists");
  return { versionId: row.id, version, definitionHash: values.definitionHash };
}

/**
 * Replaces the content of a draft. Only an unpublished row is updated; with `expectedHash` the
 * update also requires the stored hash to match (another editor saved: `conflict`).
 */
export async function updateDraftVersion(
  tx: DbOrTx,
  i: VersionContent & { versionId: string; changeNote?: string | null; expectedHash?: string },
): Promise<{ definitionHash: string }> {
  const values = versionValues(i);
  const where = [eq(formVersions.id, i.versionId), isNull(formVersions.publishedAt)];
  if (i.expectedHash !== undefined) where.push(eq(formVersions.definitionHash, i.expectedHash));
  const updated = await tx
    .update(formVersions)
    .set({ ...values, ...(i.changeNote !== undefined ? { changeNote: i.changeNote } : {}), updatedAt: new Date() })
    .where(and(...where))
    .returning({ id: formVersions.id });
  if (!updated.length) throw new ConflictError("draft_changed_or_published");
  return { definitionHash: values.definitionHash };
}

/** P9: a new draft copied from a version (default: the current one) into `max(version) + 1`. */
export async function copyToDraft(tx: DbOrTx, i: { formId: string; fromVersionId?: string; createdByUserId: string | null }): Promise<{ versionId: string; version: number }> {
  const [form] = await tx.select().from(forms).where(eq(forms.id, i.formId));
  if (!form) throw new NotFoundError("form_not_found");
  const fromId = i.fromVersionId ?? form.currentVersionId;
  if (!fromId) throw new ConflictError("no_version_to_copy");
  const [from] = await tx.select().from(formVersions).where(and(eq(formVersions.id, fromId), eq(formVersions.formId, i.formId)));
  if (!from) throw new NotFoundError("version_not_found");
  const r = await insertDraftVersion(tx, { formId: i.formId, ...parseVersion(from), createdByUserId: i.createdByUserId });
  return { versionId: r.versionId, version: r.version };
}

/**
 * P1 to P7 and P9: validates the draft, checks the DPIA gate for sensitive versions, stamps
 * `published_at` (only while still a draft) and makes it the form's current version with
 * `status = 'published'`, all in the caller's transaction. Throws `PublishRefusedError` with
 * every issue, `ConflictError` when the version is already published or the form is archived.
 */
export async function publishFormVersion(
  tx: DbOrTx,
  i: { formId: string; versionId: string; publishedByUserId: string | null; changeNote?: string | null; now?: Date; extraIssues?: PublishIssue[] },
  opts: { skipDpiaCheck?: "demo_seed" } = {},
): Promise<{ version: number; issues: PublishIssue[] }> {
  const [form] = await tx.select().from(forms).where(eq(forms.id, i.formId)).for("update");
  if (!form) throw new NotFoundError("form_not_found");
  if (form.status === "archived") throw new ConflictError("form_archived");
  const [row] = await tx.select().from(formVersions).where(and(eq(formVersions.id, i.versionId), eq(formVersions.formId, i.formId))).for("update");
  if (!row) throw new NotFoundError("version_not_found");
  if (row.publishedAt) throw new ConflictError("version_published");

  const content = parseVersion(row);
  const issues = [...validateForPublish(form.kind, content.definition, content.scoring, content.locales), ...(i.extraIssues ?? [])];
  const { sensitiveFieldKeys } = deriveVersionColumns(content.definition, content.scoring);
  if (sensitiveFieldKeys.length > 0 && opts.skipDpiaCheck !== "demo_seed" && !(await isDpiaApproved(tx, DPIA_KEY))) {
    issues.unshift({ level: "error", code: "dpia_not_approved", path: "", message: "The DPIA for sensitive assessment processing is not approved yet" });
  }
  if (!isPublishable(issues)) throw new PublishRefusedError(issues);

  const now = i.now ?? new Date();
  const published = await tx
    .update(formVersions)
    .set({
      ...versionValues(content),
      publishedAt: now,
      publishedByUserId: i.publishedByUserId,
      ...(i.changeNote !== undefined ? { changeNote: i.changeNote } : {}),
      updatedAt: now,
    })
    .where(and(eq(formVersions.id, i.versionId), isNull(formVersions.publishedAt)))
    .returning({ version: formVersions.version });
  if (!published.length) throw new ConflictError("version_published");
  await tx.update(forms).set({ status: "published", currentVersionId: i.versionId, archivedAt: null, updatedAt: now }).where(eq(forms.id, i.formId));
  return { version: published[0]!.version, issues };
}

/** The draft of a form, if any. */
export async function findDraft(tx: DbOrTx, formId: string) {
  const [row] = await tx.select().from(formVersions).where(and(eq(formVersions.formId, formId), isNull(formVersions.publishedAt)));
  return row ?? null;
}

/** A staff context (the `action()` context of a staff action). */
export type StaffCtx = Ctx;

/** P7: outcome `tagKeys` that do not exist in crm's `tags`. */
export async function missingTagIssues(tx: DbOrTx, scoring: FormScoring): Promise<PublishIssue[]> {
  const wanted = [...new Set(scoring.outcomes.flatMap((o) => o.tagKeys))];
  if (!wanted.length) return [];
  const found = new Set((await tx.select({ key: tags.key }).from(tags).where(inArray(tags.key, wanted))).map((r) => r.key));
  return scoring.outcomes.flatMap((o) =>
    o.tagKeys
      .filter((k) => !found.has(k))
      .map((k) => ({ level: "error" as const, code: "unknown_outcome" as const, path: `scoring.outcomes.${o.key}.tagKeys`, message: `Tag ${k} does not exist` })),
  );
}

/**
 * P1 to P9 for a staff publish (forms-P5's `publishVersion` action): requires `forms.publish`,
 * adds the server checks of P7 (CTA targets exist and are active, outcome tags exist) and the
 * DPIA gate, then publishes in the caller's transaction. Throws `PublishRefusedError` with every
 * issue.
 */
export async function publishVersion(tx: Tx, ctx: StaffCtx, i: { formId: string; versionId: string; changeNote: string }): Promise<{ version: number }> {
  ctx.require("forms.publish");
  const [row] = await tx.select().from(formVersions).where(and(eq(formVersions.id, i.versionId), eq(formVersions.formId, i.formId)));
  if (!row) throw new NotFoundError("version_not_found");
  const content = parseVersion(row);
  const extraIssues = [...ctaIssues(await checkCtaTargets(tx, content.definition, ctx.now)), ...(await missingTagIssues(tx, content.scoring))];
  const publishedByUserId = ctx.actor.kind === "staff" ? ctx.actor.userId : null;
  const r = await publishFormVersion(tx, { formId: i.formId, versionId: i.versionId, publishedByUserId, changeNote: i.changeNote, now: ctx.now, extraIssues });
  return { version: r.version };
}
