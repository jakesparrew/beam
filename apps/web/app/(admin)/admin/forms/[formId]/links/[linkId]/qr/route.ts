/**
 * `GET /admin/forms/[formId]/links/[linkId]/qr?format=svg|png` (`forms.write`, forms spec section 5
 * "links"): the QR code of a tracked link `<origin>/<locale>/f/<slug>?l=<key>`, as SVG or a 1024 px
 * PNG with error correction M, downloaded as `<slug>-<key>.<format>`. `no-store`; 404 for an
 * unknown link, a link of another form or a request without the permission.
 */
import { actorFromSession, getSession } from "@/lib/auth";
import { actorHasPermission, getAppDb } from "@/lib/ctx";
import { getLink } from "@/modules/forms/queries";
import { qrFileName, qrPng, qrSvg } from "@/modules/forms/service/qr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/i;

export async function GET(request: Request, { params }: { params: Promise<{ formId: string; linkId: string }> }): Promise<Response> {
  const { formId, linkId } = await params;
  const notFound = new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  const actor = actorFromSession(await getSession());
  if (!actor || actor.kind !== "staff" || !actorHasPermission(actor, "forms.write")) return notFound;
  if (!UUID.test(formId) || !UUID.test(linkId)) return notFound;
  const link = await getLink(await getAppDb(), formId, linkId);
  if (!link) return notFound;
  const format = new URL(request.url).searchParams.get("format") === "png" ? "png" : "svg";
  const headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-disposition": `attachment; filename="${qrFileName(link.slug, link.key, format)}"`,
  };
  if (format === "png") {
    const png = await qrPng(link.url);
    return new Response(png as BodyInit, { headers: { ...headers, "content-type": "image/png" } });
  }
  return new Response(await qrSvg(link.url), { headers: { ...headers, "content-type": "image/svg+xml" } });
}
