import { checkDatabase } from "@beam/db";

// Always run at request time on the Node.js runtime (node-postgres needs Node).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const database = await checkDatabase();
  return Response.json(
    { status: database.ok ? "ok" : "error", checks: { database } },
    { status: database.ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
