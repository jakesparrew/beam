/**
 * `POST /api/public/forms/[slug]/start` (forms spec section 4, rules U1, A1, A2, ID1, ID2, R2,
 * R3, U5): `{ locale, url, referrer?, embedHost?, identityToken?, embedContext?, honeypot }` ->
 * `{ submissionId, resumeToken?, prefill?: { firstName, maskedEmail, known } }`.
 *
 * Inserts the `started` submission pinned to the current version (`form.started` when the person
 * is known) and sets the signed `fsid` cookie. `embedContext` is verified by its HMAC; an
 * unsigned or tampered context is ignored. The prefill returns only the first name, the masked
 * email and the known field keys, never the person's values (edge case 19). A filled honeypot
 * gets a normal-looking answer and nothing is written (R3).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LOCALES } from "@beam/core/i18n";
import { logger } from "@/lib/logger";
import { startSubmission } from "@/modules/forms/service/submissions";
import { fsidCookie, handlePublic, parseBody } from "@/modules/forms/ui/public/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  locale: z.enum(LOCALES),
  url: z.string().max(4000),
  referrer: z.string().max(2000).optional(),
  embedHost: z.string().max(300).optional(),
  identityToken: z.string().max(1000).optional(),
  embedContext: z.string().max(10_000).optional(),
  honeypot: z.string().max(500).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params;
  return handlePublic(
    req,
    async ({ tx, ctx, ip, body, setCookie }) => {
      const input = parseBody(Body, body);
      if (input.honeypot?.trim()) {
        logger.info({ event: "forms.bot_dropped", slug, reason: "honeypot", route: "start" }, "forms.bot_dropped");
        return { submissionId: randomUUID() };
      }
      const r = await startSubmission(tx, ctx, {
        slug,
        locale: input.locale,
        url: input.url,
        ip,
        ...(input.referrer ? { referrer: input.referrer } : {}),
        ...(input.embedHost ? { embedHost: input.embedHost } : {}),
        ...(input.identityToken ? { identityToken: input.identityToken } : {}),
        ...(input.embedContext ? { embedContext: input.embedContext } : {}),
      });
      setCookie(fsidCookie(r.submissionId));
      return {
        submissionId: r.submissionId,
        ...(r.resumeToken ? { resumeToken: r.resumeToken } : {}),
        ...(r.prefill ? { prefill: { firstName: r.prefill.firstName, maskedEmail: r.prefill.maskedEmail, known: r.prefill.known } } : {}),
      };
    },
    { route: "start", slug },
  );
}
