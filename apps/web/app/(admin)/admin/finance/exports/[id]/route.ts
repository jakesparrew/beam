/**
 * `GET /admin/finance/exports/[id]` (finance spec 4.4, rule 42): staff with `reports.finance`
 * download the accountant CSV of a `done` export (`text/csv; charset=utf-8`, attachment). 401
 * without a staff session, 403 without the permission, 404 for an unknown export, 410 while it is
 * not done or after its file expired (7 days). Every download is audited as
 * `finance.export_downloaded`; `no-store`.
 */
import { actorFromSession, getSession } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { downloadFinanceExport } from "@/modules/finance/service/exports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MESSAGES = { 401: "Unauthorized", 403: "Forbidden", 404: "Not found", 410: "Gone" } as const;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const actor = actorFromSession(await getSession());
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const out = await downloadFinanceExport(await getAppDb(), actor, id, { ip, ...(request.headers.get("x-request-id") ? { requestId: request.headers.get("x-request-id")! } : {}) });
  if (out.status !== 200) return new Response(MESSAGES[out.status], { status: out.status, headers: { "Cache-Control": "private, no-store" } });
  return new Response(Buffer.from(out.bytes), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${out.name.replace(/["\\\r\n]/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
