/**
 * `GET /admin/reports/[report]/csv` (ops spec 4.3): the CSV of a report with the filters of its
 * page (`?period=`, `?at=`, `?vat=`), from `REPORT_CSV` in `modules/ops/reports/registry.ts`.
 * Staff after MFA with the report's permission (`reports.read`); audited as `data.exported`
 * with the report key, filters and row count; streamed with `no-store`.
 */
import { toCsv } from "@beam/core/ops";
import { actorFromSession, getSession, hasPermission } from "@/lib/auth";
import { createCtx, getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { isReportKey, REPORT_CSV, REPORT_CSV_COLUMNS, REPORT_CSV_PERMISSION, type OpsReadCtx } from "@/modules/ops/reports/registry";
import { brusselsDate } from "@/modules/ops/reports/revenue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const FILTER_KEYS = ["period", "at", "vat", "from", "to", "groupBy", "model"] as const;

export async function GET(request: Request, context: { params: Promise<{ report: string }> }): Promise<Response> {
  const { report } = await context.params;
  const session = await getSession();
  const actor = actorFromSession(session);
  if (!actor || actor.kind !== "staff" || !session?.mfaAt) return new Response("Unauthorized", { status: 401, headers: NO_STORE });
  if (!isReportKey(report)) return new Response("Not found", { status: 404, headers: NO_STORE });
  if (!hasPermission(actor, REPORT_CSV_PERMISSION[report])) return new Response("Forbidden", { status: 403, headers: NO_STORE });

  const url = new URL(request.url);
  const filters = Object.fromEntries(FILTER_KEYS.flatMap((k) => (url.searchParams.has(k) ? [[k, url.searchParams.get(k)!.slice(0, 40)]] : [])));
  const db = await getAppDb();
  const ctx: OpsReadCtx = { tx: db, actor, now: new Date(), locale: await adminLocale() };
  const rows: unknown[][] = [];
  for await (const row of REPORT_CSV[report](ctx, filters)) rows.push(row);

  await db.transaction(async (tx) => {
    await createCtx({ tx, actor }).audit({ action: "data.exported", entityType: "report", entityId: null, newValue: { report, filters, rows: rows.length } });
  });

  const body = toCsv([...REPORT_CSV_COLUMNS[report]], rows);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const chunk of body) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${report}-${brusselsDate(ctx.now)}.csv"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
