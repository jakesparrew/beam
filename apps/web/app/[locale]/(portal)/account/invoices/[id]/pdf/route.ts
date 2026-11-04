/**
 * `GET /[locale]/account/invoices/[id]/pdf` (finance spec 4.4, rule 40): the signed-in customer
 * owning the document gets its PDF inline. Anyone else, a signed-out visitor, an unknown id or a
 * PDF that is not rendered yet gets 404 (never 403, so ids cannot be probed).
 */
import { actorFromSession, getSession } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { getMyInvoicePdf } from "@/modules/finance/queries";
import { readFile } from "@/modules/platform/api";

const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "private, no-store" } });

export async function GET(_request: Request, { params }: { params: Promise<{ locale: string; id: string }> }): Promise<Response> {
  const { id } = await params;
  const actor = actorFromSession(await getSession());
  if (!actor || actor.kind !== "customer") return notFound();
  const db = await getAppDb();
  const doc = await getMyInvoicePdf(db, { personId: actor.personId, id });
  if (!doc) return notFound();
  const file = await readFile(db, doc.fileId);
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
