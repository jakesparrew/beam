import { timingSafeEqual } from "node:crypto";
import { runTick } from "@/lib/job-runner";
import { reportError } from "@/lib/logger";

// PL-32: Vercel Cron calls this every minute with `Authorization: Bearer $CRON_SECRET`.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function authorized(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function GET(request: Request): Promise<Response> {
  if (!authorized(request.headers.get("authorization"))) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  try {
    const result = await runTick();
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    reportError(error, { tags: { where: "cron_tick" } });
    return Response.json({ error: "internal" }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
