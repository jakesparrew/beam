/**
 * `GET /api/public/forms/result/[token]/go/[ctaKey]` (forms spec section 4, rules ID7 and edge
 * case 17): `302` to the CTA target, `cache-control: no-store`.
 *
 * Targets: `booking`/`experience` -> `/<locale>/account/book?template=<id>`, `event` -> site's
 * event page (or `/<locale>/account/book/<sessionId>`), `product` -> `/<locale>/account/shop?
 * product=<id>`, `url` -> the https URL with `utm_source=beam_form&utm_medium=result&
 * utm_campaign=<slug>`. An inactive or past target falls back to the ending's first `url` CTA or
 * to `/<locale>` with `data.fallback = true`. Every BEAM target carries `pt=<identity token>` of
 * the result's person. `assessment.cta_clicked` is recorded once per CTA per Brussels day
 * (`form:<submission_id>:cta:<cta_key>:<YYYY-MM-DD>`). An expired link goes to the result page
 * (which offers a new link); an unknown or revoked token or CTA answers `404`.
 */
import { brusselsDay, type Cta } from "@beam/core/forms";
import { NotFoundError } from "@/lib/ctx";
import { isInternalCta, resolveCtaTarget } from "@/modules/forms/service/cta-targets";
import { getResultByToken } from "@/modules/forms/service/public-queries";
import { appOrigin, createIdentityToken, IDENTITY_TTL_DAYS, resultPageUrl } from "@/modules/forms/service/tokens";
import { handlePublic, NO_STORE } from "@/modules/forms/ui/public/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const redirect = (location: string) => new Response(null, { status: 302, headers: { ...NO_STORE, location, "referrer-policy": "no-referrer" } });

function targetId(cta: Cta): string | null {
  return cta.sessionTemplateId ?? cta.sessionId ?? cta.productId ?? cta.webinarId ?? null;
}

export async function GET(req: Request, { params }: { params: Promise<{ token: string; ctaKey: string }> }): Promise<Response> {
  const { token, ctaKey } = await params;
  return handlePublic(
    req,
    async ({ tx, ctx }) => {
      const r = await getResultByToken(tx, token, ctx.now);
      if (!r) throw new NotFoundError("result_not_found");
      if ("expired" in r) return redirect(resultPageUrl(r.formSlug, r.locale, token));
      const cta = r.ending.ctas.find((c) => c.key === ctaKey);
      if (!cta) throw new NotFoundError("cta_not_found");
      const fallbackUrl = r.ending.ctas.find((c) => c.kind === "url" && c.key !== cta.key && c.url)?.url;
      const target = await resolveCtaTarget(tx, cta, r.locale, { formSlug: r.formSlug, now: ctx.now, ...(fallbackUrl ? { fallbackUrl } : {}) });
      const url = new URL(target.url);
      // ID7: BEAM targets recognise the person through a fresh identity token.
      if (r.personId && url.origin === new URL(appOrigin()).origin && (target.fallback || isInternalCta(cta))) {
        url.searchParams.set("pt", createIdentityToken({ personId: r.personId, ttlSeconds: IDENTITY_TTL_DAYS * 86_400, now: ctx.now }));
      }
      if (r.personId) {
        await ctx.recordEvent({
          kind: "assessment.cta_clicked",
          personId: r.personId,
          occurredAt: ctx.now,
          ref: { type: "form_submission", id: r.submissionId },
          dedupeKey: `form:${r.submissionId}:cta:${cta.key}:${brusselsDay(ctx.now)}`,
          isSensitive: false,
          data: {
            submission_id: r.submissionId,
            form_slug: r.formSlug,
            outcome_key: r.outcome?.key ?? null,
            cta_key: cta.key,
            cta_kind: cta.kind,
            target_id: targetId(cta),
            fallback: target.fallback,
          },
        });
      }
      return redirect(url.toString());
    },
    { route: "result_go", body: false },
  );
}
