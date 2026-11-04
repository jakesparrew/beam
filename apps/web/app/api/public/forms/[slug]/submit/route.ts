/**
 * `POST /api/public/forms/[slug]/submit` (forms spec section 4, rule U3; the route named in the
 * architecture): `{ submissionId, resumeToken?, identityToken?, answers, honeypot }` ->
 * `{ resultUrl?, redirectUrl?, endingKey, pendingConfirmation, guardianConsent, completedNow }`.
 *
 * Validation, person linking, consent, sensitive answers, score, outcome, tags, result token,
 * result email and events all happen in this request's transaction (`completeSubmission`). A
 * second submit of a completed submission answers the same result (U7); a bot (honeypot or
 * under 3 seconds, R3) gets a normal-looking thank-you and nothing is written. `completedNow` is
 * true only for the submit that completed the submission, so the renderer emits
 * `beam-form:completed` once and never for a dropped or repeated submit.
 */
import { z } from "zod";
import type { Answers } from "@beam/core/forms";
import { formSubmissions } from "@beam/db/schema";
import { eq } from "@/lib/ctx";
import { completeSubmission } from "@/modules/forms/service/submissions";
import { AnswersBody, FSID_COOKIE, handlePublic, parseBody, submissionDefinition, withKnownAnswers } from "@/modules/forms/ui/public/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  submissionId: z.string().max(64),
  resumeToken: z.string().max(200).optional(),
  identityToken: z.string().max(1000).optional(),
  answers: AnswersBody,
  honeypot: z.string().max(500).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params;
  return handlePublic(
    req,
    async ({ tx, ctx, body, cookie, ip, userAgent }) => {
      const input = parseBody(Body, body);
      const def = await submissionDefinition(tx, input.submissionId, slug);
      const read = async () =>
        (await tx.select({ s: formSubmissions.status, c: formSubmissions.consentSnapshot }).from(formSubmissions).where(eq(formSubmissions.id, input.submissionId)))[0];
      const before = (await read())?.s;
      const answers = await withKnownAnswers(tx, input.submissionId, def, input.answers as Answers);
      const r = await completeSubmission(tx, ctx, {
        submissionId: input.submissionId,
        proof: { resumeToken: input.resumeToken ?? null, fsid: cookie(FSID_COOKIE), identityToken: input.identityToken ?? null },
        answers,
        ip,
        userAgent,
        honeypot: input.honeypot ?? null,
      });
      const after = await read();
      const completedNow = before !== "completed" && after?.s === "completed";
      // C1 and C5: a marketing consent skipped for a minor shows the guardian line on the ending.
      const guardianConsent = after?.s === "completed" && (after.c ?? []).some((c) => (c as { skippedMinor?: boolean }).skippedMinor === true);
      return {
        ...(r.resultUrl ? { resultUrl: r.resultUrl } : {}),
        ...(r.redirectUrl ? { redirectUrl: r.redirectUrl } : {}),
        endingKey: r.endingKey,
        pendingConfirmation: r.pendingConfirmation,
        guardianConsent,
        completedNow,
      };
    },
    { route: "submit", slug },
  );
}
