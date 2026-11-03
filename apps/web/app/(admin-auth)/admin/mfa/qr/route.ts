/**
 * `GET /admin/mfa/qr`: the enrolment QR code as SVG for a staff session that has started but not
 * confirmed MFA (platform spec 4.4). `no-store`; 404 in every other case.
 */
import QRCode from "qrcode";
import { getSession, readMfaSecrets } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { totpUri } from "@/lib/totp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const session = await getSession();
  const notFound = new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  if (!session || session.audience !== "staff" || session.user.mfaEnrolledAt) return notFound;
  const { totpSecret } = await readMfaSecrets(await getAppDb(), session.user.id);
  if (!totpSecret) return notFound;
  const svg = await QRCode.toString(totpUri(totpSecret, session.user.email), { type: "svg", margin: 1, width: 220 });
  return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
