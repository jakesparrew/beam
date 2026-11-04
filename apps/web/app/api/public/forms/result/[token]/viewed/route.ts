/**
 * `POST /api/public/forms/result/[token]/viewed` (forms spec section 4): the result page beacon,
 * `204`. Records `form.result_viewed` for a linked submission once per Brussels day (dedupe key
 * `form:<submission_id>:viewed:<YYYY-MM-DD>`); an anonymous result records nothing (E1). An
 * unknown, revoked or expired token answers `404`.
 */
import { brusselsDay } from "@beam/core/forms";
import { NotFoundError } from "@/lib/ctx";
import { getResultByToken } from "@/modules/forms/service/public-queries";
import { handlePublic, NO_STORE } from "@/modules/forms/ui/public/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  return handlePublic(
    req,
    async ({ tx, ctx }) => {
      const r = await getResultByToken(tx, token, ctx.now);
      if (!r || "expired" in r) throw new NotFoundError("result_not_found");
      if (r.personId) {
        await ctx.recordEvent({
          kind: "form.result_viewed",
          personId: r.personId,
          occurredAt: ctx.now,
          ref: { type: "form_submission", id: r.submissionId },
          dedupeKey: `form:${r.submissionId}:viewed:${brusselsDay(ctx.now)}`,
          isSensitive: false,
          data: { submission_id: r.submissionId, form_slug: r.formSlug, outcome_key: r.outcome?.key ?? null },
        });
      }
      return new Response(null, { status: 204, headers: NO_STORE });
    },
    { route: "result_viewed", body: false },
  );
}
