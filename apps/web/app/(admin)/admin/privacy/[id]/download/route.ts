/**
 * `GET /admin/privacy/[id]/download` (ops spec 4.3, rule 60): decrypts and streams the subject's
 * export zip, part by part. `privacy.run` staff only; only a `done` export whose parts have not
 * expired (else 410). Audited as `privacy.export_downloaded`; `no-store`.
 */
import { actorFromSession, getSession, hasPermission } from "@/lib/auth";
import { createCtx, getAppDb } from "@/lib/ctx";
import { openExportStream } from "@/modules/ops/privacy/export-zip";
import { getPrivacyExportForDownload } from "@/modules/ops/privacy/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const text = (body: string, status: number) => new Response(body, { status, headers: { "cache-control": "no-store" } });

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const actor = actorFromSession(await getSession());
  if (!actor || actor.kind !== "staff") return text("Unauthorized", 401);
  if (!hasPermission(actor, "privacy.run")) return text("Forbidden", 403);
  const db = await getAppDb();
  const exp = await getPrivacyExportForDownload(db, id);
  if (!exp) return text("Not found", 404);
  if (exp.status !== "done") return text("Gone", 410);
  const stream = await openExportStream(db, exp);
  if (!stream) return text("Gone", 410);
  await db.transaction(async (tx) => {
    const ctx = createCtx({ tx, actor });
    await ctx.audit({ action: "privacy.export_downloaded", entityType: "privacy_request", entityId: exp.id, newValue: { parts: 1 + exp.partFileIds.length } });
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="beam-privacy-export-${exp.id.slice(0, 8)}.zip"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
