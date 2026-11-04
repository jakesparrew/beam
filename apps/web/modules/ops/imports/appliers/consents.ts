/**
 * Applier for kind `consents` (ops spec rules 47, 47a). Each row appends one `consent_records`
 * row through crm's `recordConsent` (method `import`); earlier records are never edited, so the
 * consent history stays. A `granted` row for an address suppressed for `all` or for that purpose
 * is `skipped` with `suppressed`, checked here before crm is called, in dry runs too. The purpose
 * comes from the column or `options.consentPurpose`; the wording version from the column, the
 * option, else `legacy-import`. Only a status column creates consent: no other column does.
 */
import type { Tx } from "@beam/db";
import { suppressions } from "@beam/db/schema";
import { CONSENT_PURPOSES, emailHash, type ConsentPurpose } from "@beam/core/crm";
import type { ImportMapping } from "@beam/core/ops";
import { and, eq, inArray } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { recordConsent } from "@/modules/crm/api";
import { assertNotErased, cell, parseInstantCell, requireEmail, resolvePersonByEmail, RowError, type ImportRow, type RowOutcome } from "../apply";

const GRANTED = new Set(["granted", "subscribed", "subscribe", "opted_in", "opt_in", "optin", "yes", "ja", "oui", "true", "1", "y", "confirmed"]);
const WITHDRAWN = new Set(["withdrawn", "unsubscribed", "unsubscribe", "opted_out", "opt_out", "optout", "no", "nee", "non", "false", "0", "n", "cleaned"]);

export function consentStatusOf(value: string | null): "granted" | "withdrawn" {
  const v = (value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (GRANTED.has(v)) return "granted";
  if (WITHDRAWN.has(v)) return "withdrawn";
  throw new RowError("invalid_status");
}

function purposeOf(row: ImportRow, mapping: ImportMapping): ConsentPurpose {
  const v = cell(row, "purpose")?.toLowerCase() ?? mapping.options.consentPurpose;
  if (!v) throw new RowError("missing_purpose");
  if (!(CONSENT_PURPOSES as readonly string[]).includes(v)) throw new RowError("invalid_purpose");
  return v as ConsentPurpose;
}

/** Rule 47: suppressed for `all` or for the purpose. */
async function isSuppressedFor(tx: Tx, email: string, purpose: ConsentPurpose): Promise<boolean> {
  const scopes = ["all", purpose].filter((s) => s === "all" || ["newsletter", "events", "member_comms", "b2b"].includes(s)) as ("all" | "newsletter" | "events" | "member_comms" | "b2b")[];
  const [row] = await tx
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(and(eq(suppressions.emailHash, emailHash(email)), inArray(suppressions.scope, scopes)))
    .limit(1);
  return !!row;
}

export async function applyConsentRow(tx: Tx, ctx: JobCtx, row: ImportRow, opts: { dryRun: boolean; mapping: ImportMapping }): Promise<RowOutcome> {
  const email = requireEmail(row);
  await assertNotErased(tx, email);
  const status = consentStatusOf(cell(row, "status"));
  const purpose = purposeOf(row, opts.mapping);
  const recordedAt = parseInstantCell(cell(row, "recorded_at"), opts.mapping.options.dateFormat) ?? undefined;
  const wordingVersion = cell(row, "wording_version") ?? opts.mapping.options.consentWordingVersion ?? "legacy-import";
  if (status === "granted" && (await isSuppressedFor(tx, email, purpose))) return { status: "skipped", message: "suppressed", entityType: "consent" };

  const { personId } = await resolvePersonByEmail(tx, ctx, row, email, opts);
  if (opts.dryRun) return { status: "imported", entityType: "consent", ...(personId ? { personId } : {}) };
  const source = (cell(row, "source") ? `import:${row.source}:${cell(row, "source")}` : `import:${row.source}`).slice(0, 200);
  const result = await recordConsent(tx, ctx, { personId: personId!, purpose, status, method: "import", source, wordingVersion, ...(recordedAt ? { recordedAt } : {}) });
  switch (result.outcome) {
    case "recorded":
      return { status: "imported", personId: personId!, entityType: "consent", ...(result.recordId ? { entityId: result.recordId } : {}) };
    case "skipped_suppressed":
      return { status: "skipped", message: "suppressed", personId: personId!, entityType: "consent" };
    case "skipped_minor":
      return { status: "skipped", message: "minor", personId: personId!, entityType: "consent" };
    default:
      return { status: "skipped", message: "unchanged", personId: personId!, entityType: "consent" };
  }
}
