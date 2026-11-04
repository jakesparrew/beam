/**
 * `GET /admin/finance/invoices/[id]/pdf` (finance spec 4.4): staff with `invoices.read` get the
 * document's PDF inline; 404 when the document does not exist or its PDF is not rendered.
 * Viewing is not audited (spec section 7).
 */
import { invoices } from "@beam/db/schema";
import { getSession, hasPermission, actorFromSession } from "@/lib/auth";
import { eq, getAppDb } from "@/lib/ctx";
import { readFile } from "@/modules/platform/api";

const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "private, no-store" } });

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const session = await getSession();
  const actor = actorFromSession(session);
  if (!actor || actor.kind !== "staff") return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "private, no-store" } });
  if (!hasPermission(actor, "invoices.read")) return notFound();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return notFound();
  const db = await getAppDb();
  const [doc] = await db
    .select({ number: invoices.number, pdfStatus: invoices.pdfStatus, pdfFileId: invoices.pdfFileId })
    .from(invoices)
    .where(eq(invoices.id, id));
  if (!doc || doc.pdfStatus !== "rendered" || !doc.pdfFileId) return notFound();
  const file = await readFile(db, doc.pdfFileId);
  if (!file) return notFound();
  return new Response(Buffer.from(file.bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${doc.number}.pdf"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
