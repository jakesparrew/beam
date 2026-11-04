/**
 * Applier for kind `tags` (ops spec rule 43): the tag comes from the `tag_key` column (several
 * keys separated by `,` or `;`, as Mailchimp exports them) or `options.tagKey` for the whole
 * file. Tags are applied through crm's `applyTag` (source `import`); an unknown tag key is an
 * `unknown_tag` error, a tag the person already has is `skipped` with `existing`.
 */
import type { Tx } from "@beam/db";
import { tags } from "@beam/db/schema";
import type { ImportMapping } from "@beam/core/ops";
import { inArray } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { applyTag } from "@/modules/crm/api";
import { assertNotErased, cell, requireEmail, resolvePersonByEmail, RowError, type ImportRow, type RowOutcome } from "../apply";

export function tagKeysOf(row: ImportRow, mapping: ImportMapping): string[] {
  const raw = cell(row, "tag_key") ?? mapping.options.tagKey ?? "";
  const keys = [
    ...new Set(
      raw
        .split(/[,;]/)
        .map((k) => k.trim().replace(/^"|"$/g, "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (!keys.length) throw new RowError("missing_tag");
  return keys;
}

export async function applyTagRow(tx: Tx, ctx: JobCtx, row: ImportRow, opts: { dryRun: boolean; mapping: ImportMapping }): Promise<RowOutcome> {
  const email = requireEmail(row);
  await assertNotErased(tx, email);
  const keys = tagKeysOf(row, opts.mapping);
  const known = await tx.select({ id: tags.id, key: tags.key }).from(tags).where(inArray(tags.key, keys));
  if (known.length !== keys.length) throw new RowError("unknown_tag");
  const { personId } = await resolvePersonByEmail(tx, ctx, row, email, opts);
  if (opts.dryRun) return { status: "imported", entityType: "tag", entityId: known[0]!.id, ...(personId ? { personId } : {}) };
  let applied = 0;
  for (const key of keys) {
    if ((await applyTag(tx, ctx, personId!, key, "import")).applied) applied += 1;
  }
  return { status: applied ? "imported" : "skipped", ...(applied ? {} : { message: "existing" }), personId: personId!, entityType: "tag", entityId: known[0]!.id };
}
