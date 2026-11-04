/**
 * Applier for kind `companies` (ops spec rule 43, B2B lists). crm's `upsertCompany` matches on
 * the VAT number, else `lower(name)`; a row with `contact_email` also links that person (created
 * through `upsertPersonFromImport` when unknown) with `addCompanyContact`. The company's external
 * id is kept in `import_external_ids` (rule 50).
 */
import type { Tx } from "@beam/db";
import { companies } from "@beam/db/schema";
import type { CompanySize, DecisionRole, PostalAddress } from "@beam/core/crm";
import type { ImportMapping } from "@beam/core/ops";
import { sql } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { addCompanyContact, upsertCompany } from "@/modules/crm/api";
import { assertNotErased, cell, externalEntityId, optionalEmail, resolvePersonByEmail, RowError, writeExternalId, type ImportRow, type RowOutcome } from "../apply";

const SIZES: Record<string, CompanySize> = { "1_9": "1_9", "1-9": "1_9", "10_49": "10_49", "10-49": "10_49", "50_249": "50_249", "50-249": "50_249", "250_plus": "250_plus", "250+": "250_plus" };
const ROLES: readonly DecisionRole[] = ["decision_maker", "influencer", "user", "gatekeeper"];

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== "")) as T;
}

export async function applyCompanyRow(tx: Tx, ctx: JobCtx, row: ImportRow, opts: { dryRun: boolean; mapping: ImportMapping }): Promise<RowOutcome> {
  const name = cell(row, "name");
  if (!name) throw new RowError("missing_name");
  const contactEmail = optionalEmail(row, "contact_email");
  await assertNotErased(tx, contactEmail);
  const vatNumber = cell(row, "vat_number")?.replace(/[\s.]/g, "").toUpperCase() ?? null;
  const roleText = cell(row, "contact_decision_role")?.toLowerCase().replace(/[\s-]+/g, "_") ?? null;
  const decisionRole = roleText && (ROLES as readonly string[]).includes(roleText) ? (roleText as DecisionRole) : undefined;
  const size = SIZES[(cell(row, "size") ?? "").replace(/\s/g, "").toLowerCase()];
  const street = cell(row, "street");
  const postalCode = cell(row, "postal_code");
  const city = cell(row, "city");
  const country = (cell(row, "country") ?? "BE").slice(0, 2).toUpperCase();
  const address: PostalAddress | undefined = street || postalCode || city ? compact({ street: street ?? undefined, postal_code: postalCode ?? undefined, city: city ?? undefined, country }) : undefined;

  if (opts.dryRun) {
    const known = await externalEntityId(tx, row.source, "company", cell(row, "external_id"));
    const [match] = known
      ? [{ id: known }]
      : await tx
          .select({ id: companies.id })
          .from(companies)
          .where(vatNumber ? sql`${companies.vatNumber} = ${vatNumber} or lower(${companies.name}) = ${name.toLowerCase()}` : sql`lower(${companies.name}) = ${name.toLowerCase()}`)
          .limit(1);
    if (contactEmail) await resolvePersonByEmail(tx, ctx, row, contactEmail, opts);
    return match ? { status: "updated", message: "matched", entityType: "company", entityId: match.id } : { status: "imported", message: "new", entityType: "company" };
  }

  const { companyId, outcome } = await upsertCompany(
    tx,
    ctx,
    compact({ name, vatNumber: vatNumber ?? undefined, address, website: cell(row, "website") ?? undefined, industry: cell(row, "industry") ?? undefined, size }),
  );
  await writeExternalId(tx, row, "company", companyId);
  let personId: string | undefined;
  if (contactEmail) {
    personId = (await resolvePersonByEmail(tx, ctx, row, contactEmail, opts)).personId ?? undefined;
    if (personId) await addCompanyContact(tx, ctx, compact({ companyId, personId, position: cell(row, "contact_position") ?? undefined, decisionRole }));
  }
  return { status: outcome === "created" ? "imported" : "updated", message: outcome === "created" ? "new" : "matched", entityType: "company", entityId: companyId, ...(personId ? { personId } : {}) };
}
