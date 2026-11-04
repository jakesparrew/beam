/**
 * `GET /admin/imports/[id]/rows.csv` (ops spec 4.3): the rows of an import with status `error`
 * or `skipped` (of the real run, else of the dry run) with their message code and mapped fields,
 * so staff can fix the file. Staff with `persons.write`; audited as `data.exported`; `no-store`.
 */
import { importRows, imports } from "@beam/db/schema";
import { toCsv } from "@beam/core/ops";
import { actorFromSession, getSession, hasPermission } from "@/lib/auth";
import { and, asc, createCtx, eq, getAppDb, inArray } from "@/lib/ctx";
import { DUP_MARKER } from "@/modules/ops/imports/apply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const actor = actorFromSession(await getSession());
  if (!actor || actor.kind !== "staff") return new Response("Unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
  if (!hasPermission(actor, "persons.write")) return new Response("Forbidden", { status: 403, headers: { "cache-control": "no-store" } });
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });

  const db = await getAppDb();
  const [imp] = await db.select({ id: imports.id, name: imports.name, isDryRun: imports.isDryRun, status: imports.status }).from(imports).where(eq(imports.id, id));
  if (!imp) return new Response("Not found", { status: 404 });
  const dry = imp.isDryRun && imp.status === "dry_run";
  const statusCol = dry ? importRows.dryRunStatus : importRows.status;
  const rows = await db
    .select({ rowNumber: importRows.rowNumber, status: statusCol, message: importRows.message, data: importRows.data })
    .from(importRows)
    .where(and(eq(importRows.importId, id), inArray(statusCol, ["error", "skipped"])))
    .orderBy(asc(importRows.rowNumber));
  const fields = [...new Set(rows.flatMap((r) => Object.keys(r.data)).filter((k) => k !== DUP_MARKER))].sort();
  await db.transaction(async (tx) => {
    const ctx = createCtx({ tx, actor });
    await ctx.audit({ action: "data.exported", entityType: "import_rows", entityId: id, newValue: { entity: "import_rows", filters: { status: ["error", "skipped"], mode: dry ? "dry" : "run" }, rows: rows.length } });
  });

  const body = toCsv(
    ["row_number", "status", "message", ...fields],
    rows.map((r) => [r.rowNumber, r.status, r.message, ...fields.map((f) => r.data[f] ?? "")]),
  );
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const chunk of body) controller.enqueue(chunk);
      controller.close();
    },
  });
  const filename = `import-${imp.name.replace(/[^\w-]+/g, "_").slice(0, 60) || "rows"}-errors.csv`;
  return new Response(stream, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
}
