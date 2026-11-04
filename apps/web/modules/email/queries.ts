/**
 * email queries (email spec section 4 "Queries"). email-P5: the template store.
 *
 * - `listTemplates(db, { kind?, status?, q?, module?, page })`: the Transactional and Marketing
 *   tabs of `/admin/templates` (archived rows only with `status: 'archived'`), 50 per page.
 * - `getTemplate(db, templateId)`: template, draft, current version, completeness, references
 *   (active campaigns, automation use), version history, copy slots and merge fields.
 * - `getPreview(db, { templateId, use, locale, as }, { canReadPersons })`: subject, preheader,
 *   HTML, text, size and warnings of one locale for a sample persona or a real contact
 *   (`persons.read`; otherwise `forbidden`).
 *
 * The pages call these after `requireStaff({ permission: 'email.write' })` (spec: staff queries
 * need `email.write`); the functions take the database so tests and pages share them.
 */
import type { DbOrTx } from "@beam/db";
import { ForbiddenError } from "@beam/core/errors";
import { GetPreviewInput, ListTemplatesInput, type GetPreviewInput as GetPreviewArgs, type ListTemplatesInput as ListTemplatesArgs } from "@beam/core/email";
import { eq } from "@/lib/ctx";
import { emailTemplates } from "@beam/db/schema";
import { buildPreview, personRecipient, samplePersona, type PreviewResult } from "./server/preview";
import { draftVersionOf, listTemplateRows, loadTemplateDetail, loadTemplateVersion, transactionalModules, versionById, type TemplateDetail } from "./server/templates";

export type { PreviewResult, PreviewWarning, RecipientContext } from "./server/preview";
export type { TemplateDetail, TemplateListRow } from "./server/templates";
export { samplePersona } from "./server/preview";

export async function listTemplates(db: DbOrTx, input: ListTemplatesArgs = {}) {
  const args = ListTemplatesInput.parse(input);
  return listTemplateRows(db, args);
}

export function listTemplateModules(db: DbOrTx): Promise<string[]> {
  return transactionalModules(db);
}

export function getTemplate(db: DbOrTx, templateId: string): Promise<TemplateDetail | null> {
  return loadTemplateDetail(db, templateId);
}

/**
 * The preview of one locale. `opts.versionId` previews an older version (version history).
 * Returns null when the template or the requested version does not exist.
 */
export async function getPreview(db: DbOrTx, input: GetPreviewArgs, opts: { canReadPersons: boolean; versionId?: string; now?: Date }): Promise<PreviewResult | null> {
  const args = GetPreviewInput.parse(input);
  const [template] = await db.select().from(emailTemplates).where(eq(emailTemplates.id, args.templateId));
  if (!template) return null;
  const version = opts.versionId
    ? await loadTemplateVersion(db, template.id, opts.versionId)
    : args.use === "draft"
      ? ((await draftVersionOf(db, template.id)) ?? (await versionById(db, template.currentVersionId)))
      : await versionById(db, template.currentVersionId);
  if (!version) return null;
  let recipient = samplePersona("lead");
  if (args.as && "personId" in args.as) {
    if (!opts.canReadPersons) throw new ForbiddenError("forbidden: persons.read", "persons.read");
    const found = await personRecipient(db, args.as.personId, version.document, args.locale);
    if (!found) return null;
    recipient = found;
  } else if (args.as) {
    recipient = samplePersona(args.as.sample, args.as.assessmentOutcome);
  }
  return buildPreview(db, { template, version, locale: args.locale, recipient, ...(opts.now ? { now: opts.now } : {}) });
}
