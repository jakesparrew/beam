/**
 * `GET /admin/forms/[formId]/submissions/export` (`forms.write` and `persons.read`; forms spec
 * section 5, SE4): the CSV of the submissions matching the list filters of the query string,
 * non-sensitive columns only (`toSubmissionCsv`). Column titles come from the filtered version,
 * else the current version, else the newest draft. Staff after MFA; audited as
 * `forms.submissions_exported` with the filters and the row count; `private, no-store`.
 */
import { formVersions } from "@beam/db/schema";
import { actorFromSession, getSession, hasPermission } from "@/lib/auth";
import { createCtx, desc, eq, getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { getForm, listSubmissionsForExport, parseSubmissionFilter } from "@/modules/forms/queries";
import { toSubmissionCsv } from "@/modules/forms/service/export-csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const UUID = /^[0-9a-f-]{36}$/i;

export async function GET(request: Request, { params }: { params: Promise<{ formId: string }> }): Promise<Response> {
  const { formId } = await params;
  const session = await getSession();
  const actor = actorFromSession(session);
  if (!actor || actor.kind !== "staff" || !session?.mfaAt) return new Response("Unauthorized", { status: 401, headers: NO_STORE });
  if (!hasPermission(actor, "forms.write") || !hasPermission(actor, "persons.read")) return new Response("Forbidden", { status: 403, headers: NO_STORE });
  if (!UUID.test(formId)) return new Response("Not found", { status: 404, headers: NO_STORE });
  const db = await getAppDb();
  const form = await getForm(db, formId);
  if (!form) return new Response("Not found", { status: 404, headers: NO_STORE });

  const sp = Object.fromEntries(new URL(request.url).searchParams.entries());
  const { cursor: _cursor, ...filter } = parseSubmissionFilter(sp);
  const versionId = filter.versionId ?? form.current?.id ?? form.draft?.id;
  const [version] = versionId
    ? await db.select().from(formVersions).where(eq(formVersions.id, versionId))
    : await db.select().from(formVersions).where(eq(formVersions.formId, formId)).orderBy(desc(formVersions.version)).limit(1);
  if (!version || version.formId !== formId) return new Response("Not found", { status: 404, headers: NO_STORE });

  const rows = await listSubmissionsForExport(db, { formId, ...filter });
  const locale = await adminLocale();
  const csv = toSubmissionCsv(rows, version, locale);
  await db.transaction(async (tx) => {
    await createCtx({ tx, actor }).audit({ action: "forms.submissions_exported", entityType: "form", entityId: formId, newValue: { filters: filter, rows: rows.length, version: version.version } });
  });
  const day = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${form.slug}-submissions-${day}.csv"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
