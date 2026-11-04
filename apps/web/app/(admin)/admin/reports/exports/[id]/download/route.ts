/**
 * `GET /admin/reports/exports/[id]/download` (ops spec 4.3, rule 55): streams a store-only zip of
 * the export's CSV parts (and `README.csv` for a full export). Only the creator or a user with
 * `users.manage`; only `done` exports before `expires_at` (a `failed`, `expired` or running
 * export gives 410). Audited as `export.downloaded`; `no-store`.
 */
import { dataExports } from "@beam/db/schema";
import { zipStore, type ZipEntry } from "@beam/core/ops";
import { actorFromSession, getSession, hasPermission } from "@/lib/auth";
import { createCtx, eq, getAppDb } from "@/lib/ctx";
import { getExportForDownload, readExportPart } from "@/modules/ops/exports/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const text = (body: string, status: number) => new Response(body, { status, headers: { "cache-control": "no-store" } });

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const actor = actorFromSession(await getSession());
  if (!actor || actor.kind !== "staff") return text("Unauthorized", 401);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return text("Not found", 404);

  const db = await getAppDb();
  const [row] = await db.select({ id: dataExports.id, createdByUserId: dataExports.createdByUserId }).from(dataExports).where(eq(dataExports.id, id));
  if (!row) return text("Not found", 404);
  if (row.createdByUserId !== actor.userId && !hasPermission(actor, "users.manage")) return text("Forbidden", 403);
  const exp = await getExportForDownload(db, id);
  if (!exp) return text("Gone", 410);

  await db.transaction(async (tx) => {
    const ctx = createCtx({ tx, actor });
    await ctx.audit({ action: "export.downloaded", entityType: "data_export", entityId: exp.id, newValue: { kind: exp.kind, entity: exp.entity ?? "full", rows: exp.rowCount, parts: exp.parts.length } });
  });

  async function* entries(): AsyncIterable<ZipEntry> {
    for (const part of exp!.parts) {
      const bytes = await readExportPart(db, part.fileId);
      if (!bytes) continue;
      yield {
        name: part.name,
        data: (async function* () {
          yield bytes;
        })(),
      };
    }
  }
  const zip = zipStore(entries());
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of zip) controller.enqueue(chunk);
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  const filename = `beam-export-${exp.entity ?? "full"}-${exp.id.slice(0, 8)}.zip`;
  return new Response(stream, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
