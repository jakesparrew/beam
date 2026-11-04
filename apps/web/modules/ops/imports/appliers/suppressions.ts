/**
 * Applier for kind `suppressions` (ops spec rules 47, 47a, cut-over step 5). Suppressions are
 * written only through crm's `addSuppression` (the one writer of `suppressions`, which also ends
 * running marketing sequences); an import never removes one. Scope defaults to `all`; the reason
 * is read from the file when it is one of crm's reasons, else derived from the preset
 * (`mailchimp_cleaned` = `hard_bounce`) or `unsubscribe`. `erased` is never imported.
 */
import type { Tx } from "@beam/db";
import { suppressions } from "@beam/db/schema";
import { emailHash, SUPPRESSION_REASONS, SUPPRESSION_SCOPES, type SuppressionReason, type SuppressionScope } from "@beam/core/crm";
import type { ImportMapping } from "@beam/core/ops";
import { and, eq } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { addSuppression } from "@/modules/crm/api";
import { assertNotErased, cell, parseInstantCell, requireEmail, RowError, type ImportRow, type RowOutcome } from "../apply";
import { matchPerson } from "../match";

const SCOPE_ALIASES: Record<string, SuppressionScope> = { "": "all", all: "all", alles: "all", tout: "all", marketing: "all", newsletter: "newsletter", nieuwsbrief: "newsletter", events: "events", event: "events", member_comms: "member_comms", members: "member_comms", b2b: "b2b" };

function scopeOf(value: string | null): SuppressionScope {
  const v = (value ?? "").trim().toLowerCase();
  if ((SUPPRESSION_SCOPES as readonly string[]).includes(v)) return v as SuppressionScope;
  const alias = SCOPE_ALIASES[v];
  if (!alias) throw new RowError("invalid_scope");
  return alias;
}

function reasonOf(value: string | null, mapping: ImportMapping): SuppressionReason {
  const v = (value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (v !== "erased" && (SUPPRESSION_REASONS as readonly string[]).includes(v)) return v as SuppressionReason;
  if (v === "bounce" || v === "bounced" || v === "cleaned") return "hard_bounce";
  if (v === "spam" || v === "abuse") return "complaint";
  return mapping.options.preset === "mailchimp_cleaned" ? "hard_bounce" : "unsubscribe";
}

export async function applySuppressionRow(tx: Tx, ctx: JobCtx, row: ImportRow, opts: { dryRun: boolean; mapping: ImportMapping }): Promise<RowOutcome> {
  const email = requireEmail(row);
  await assertNotErased(tx, email);
  const scope = scopeOf(cell(row, "scope"));
  const reason = reasonOf(cell(row, "reason"), opts.mapping);
  parseInstantCell(cell(row, "suppressed_at"), opts.mapping.options.dateFormat);
  const match = await matchPerson(tx, { ...row, data: { email } });

  if (opts.dryRun) {
    const [existing] = await tx
      .select({ id: suppressions.id })
      .from(suppressions)
      .where(and(eq(suppressions.emailHash, emailHash(email)), eq(suppressions.scope, scope)))
      .limit(1);
    if (existing) return { status: "skipped", message: "existing", entityType: "suppression", entityId: existing.id, ...(match.personId ? { personId: match.personId } : {}) };
    return { status: "imported", entityType: "suppression", ...(match.personId ? { personId: match.personId } : {}) };
  }

  const { suppressionId, created } = await addSuppression(tx, ctx, { email, scope, reason, source: `import:${row.source}`, ...(match.personId ? { personId: match.personId } : {}) });
  return {
    status: created ? "imported" : "skipped",
    ...(created ? {} : { message: "existing" }),
    entityType: "suppression",
    entityId: suppressionId,
    ...(match.personId ? { personId: match.personId } : {}),
  };
}
