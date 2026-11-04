/**
 * Applier for kind `persons` (ops spec rules 45, 46, 47a, 50). ops decides the match; crm writes:
 * a new or email-matched person goes through `upsertPersonFromImport` (crm owns the
 * `lower(email)` uniqueness and race handling), a person matched by external id or by phone and
 * name through `updatePersonFields`. Existing values are kept unless `options.overwrite`;
 * `locale`, `acquisition` and the creation date are never overwritten. crm's external-id key of
 * the source is written through `updatePersonFields(..., { onlyEmpty: true })`.
 */
import type { Tx } from "@beam/db";
import type { PersonFieldPatch } from "@beam/core/crm";
import type { ImportMapping } from "@beam/core/ops";
import type { JobCtx } from "@/lib/job-runner";
import { addCompanyContact, updatePersonFields, upsertCompany, upsertPersonFromImport } from "@/modules/crm/api";
import {
  assertNotErased,
  cell,
  crmExternalIdKey,
  DUP_MARKER,
  newPersonAcquisition,
  newPersonLocale,
  optionalEmail,
  parseDateCell,
  RowError,
  writeExternalId,
  type ImportRow,
  type RowOutcome,
} from "../apply";
import { matchPerson } from "../match";

const CHANNELS = { email: "email", "e-mail": "email", mail: "email", phone: "phone", telefoon: "phone", téléphone: "phone", sms: "phone", whatsapp: "whatsapp" } as const;

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== "")) as T;
}

export async function applyPersonRow(tx: Tx, ctx: JobCtx, row: ImportRow, opts: { dryRun: boolean; mapping: ImportMapping }): Promise<RowOutcome> {
  const { mapping } = opts;
  const fmt = mapping.options.dateFormat;
  const email = optionalEmail(row, "email");
  const phone = cell(row, "phone");
  const lastName = cell(row, "last_name");
  if (!email && !(phone && lastName)) throw new RowError("missing_email");
  await assertNotErased(tx, email);

  const birthOn = parseDateCell(cell(row, "birth_on"), fmt) ?? undefined;
  const createdAt = parseDateCell(cell(row, "created_at"), fmt);
  const channelText = cell(row, "preferred_channel")?.toLowerCase() ?? "";
  const preferredChannel = (CHANNELS as Record<string, "email" | "phone" | "whatsapp">)[channelText];
  const duplicate = !!cell(row, DUP_MARKER);
  const match = await matchPerson(tx, row);

  if (opts.dryRun) {
    if (match.personId || duplicate) {
      return { status: "updated", message: duplicate && !match.personId ? "duplicate_in_file" : "matched", ...(match.personId ? { personId: match.personId, entityType: "person", entityId: match.personId } : { entityType: "person" }) };
    }
    return { status: "imported", message: "new", entityType: "person" };
  }

  const patch: PersonFieldPatch = compact({
    firstName: cell(row, "first_name") ?? undefined,
    lastName: lastName ?? undefined,
    phone: phone ?? undefined,
    birthOn,
    postalCode: cell(row, "postal_code") ?? undefined,
    city: cell(row, "city") ?? undefined,
    preferredChannel,
  });
  const onlyEmpty = !mapping.options.overwrite;
  let personId: string;
  let created = false;
  if (match.personId && match.how !== "email") {
    personId = match.personId;
    await updatePersonFields(tx, ctx, personId, patch, { onlyEmpty });
  } else {
    const result = await upsertPersonFromImport(
      tx,
      ctx,
      {
        email,
        firstName: patch.firstName ?? null,
        lastName: patch.lastName ?? null,
        phone: patch.phone ?? null,
        birthOn: patch.birthOn ?? null,
        postalCode: patch.postalCode ?? null,
        city: patch.city ?? null,
        locale: newPersonLocale(row, mapping),
        acquisition: newPersonAcquisition(row, { createdAt }),
      },
      row.importId,
    );
    personId = result.personId;
    created = result.outcome === "created";
    if (!created && !onlyEmpty) await updatePersonFields(tx, ctx, personId, patch, { onlyEmpty: false });
    else if (preferredChannel) await updatePersonFields(tx, ctx, personId, { preferredChannel }, { onlyEmpty: true });
  }

  const externalId = cell(row, "external_id");
  const crmKey = crmExternalIdKey(row.source, mapping);
  if (externalId && crmKey) await updatePersonFields(tx, ctx, personId, { externalIds: { [crmKey]: externalId.slice(0, 200) } }, { onlyEmpty: true });
  await writeExternalId(tx, row, "person", personId);

  const companyName = cell(row, "company_name");
  if (companyName) {
    const { companyId } = await upsertCompany(tx, ctx, { name: companyName });
    await addCompanyContact(tx, ctx, { companyId, personId });
  }
  return { status: created ? "imported" : "updated", message: created ? "new" : duplicate ? "duplicate_in_file" : "matched", personId, entityType: "person", entityId: personId };
}
