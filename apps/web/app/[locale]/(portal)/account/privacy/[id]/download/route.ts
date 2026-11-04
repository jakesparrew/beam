/**
 * `GET /[locale]/account/privacy/[id]/download` (ops spec 4.3, rule 60): the signed-in customer
 * downloads their own export, decrypted and streamed part by part, until it expires (7 days).
 * Anyone else, a signed-out visitor, an unknown id or an unfinished export gets 404 (never 403,
 * so ids cannot be probed); an expired export gives 410.
 */
import { actorFromSession, getSession } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { openExportStream } from "@/modules/ops/privacy/export-zip";
import { getPrivacyExportForDownload } from "@/modules/ops/privacy/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const text = (body: string, status: number) => new Response(body, { status, headers: { "cache-control": "private, no-store" } });

export async function GET(_request: Request, { params }: { params: Promise<{ locale: string; id: string }> }): Promise<Response> {
  const { id } = await params;
  const actor = actorFromSession(await getSession());
  if (!actor || actor.kind !== "customer") return text("Not found", 404);
  const db = await getAppDb();
  const exp = await getPrivacyExportForDownload(db, id);
  if (!exp || exp.personId !== actor.personId || exp.status !== "done") return text("Not found", 404);
  const stream = await openExportStream(db, exp);
  if (!stream) return text("Gone", 410);
  return new Response(stream, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="beam-my-data-${exp.id.slice(0, 8)}.zip"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
