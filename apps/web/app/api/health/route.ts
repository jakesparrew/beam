import { healthReport } from "@/lib/alerts";
import { getAppDb } from "@/lib/ctx";

// PL-74: public, never cached, Node.js runtime (node-postgres needs Node).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  let report;
  try {
    report = await healthReport(await getAppDb());
  } catch (error) {
    return Response.json(
      { status: "error", version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? "dev", checks: { database: { ok: false, error: error instanceof Error ? error.message.slice(0, 200) : "error" } } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  return Response.json(report, { status: report.status === "error" ? 503 : 200, headers: { "cache-control": "no-store" } });
}
