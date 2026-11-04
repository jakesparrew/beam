/**
 * `GET /api/public/forms/embed.js` (forms spec section 4 and 5): the embed script for partner and
 * landing-page sites, `application/javascript`, `cache-control: public, max-age=3600`. No
 * effects, no database read; the BEAM origin is `APP_URL`.
 */
import { appOrigin } from "@/modules/forms/service/tokens";
import { embedScript } from "@/modules/forms/ui/public/embed-script";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(embedScript(appOrigin()), {
    status: 200,
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*",
    },
  });
}
