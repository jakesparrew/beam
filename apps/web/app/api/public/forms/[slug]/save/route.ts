/**
 * `POST /api/public/forms/[slug]/save` (forms spec section 4, rules U2, L5, SE2, ID9):
 * `{ submissionId, resumeToken?, identityToken?, sectionKey, answers }` ->
 * `{ next: { sectionKey } | { end: true } }` or `400 validation` with the field keys.
 *
 * Proof of ownership: the resume token, the signed `fsid` cookie, or a session or identity token
 * of the submission's person; otherwise `404`. An archived form answers `410 form_closed`, a
 * completed submission `409 conflict`. The server's `nextStep` is authoritative (L5).
 */
import { z } from "zod";
import type { Answers } from "@beam/core/forms";
import { saveSection } from "@/modules/forms/service/submissions";
import { AnswersBody, FSID_COOKIE, handlePublic, parseBody, submissionDefinition, withKnownAnswers } from "@/modules/forms/ui/public/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  submissionId: z.string().max(64),
  resumeToken: z.string().max(200).optional(),
  identityToken: z.string().max(1000).optional(),
  sectionKey: z.string().max(64),
  answers: AnswersBody,
});

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params;
  return handlePublic(
    req,
    async ({ tx, ctx, body, cookie }) => {
      const input = parseBody(Body, body);
      const def = await submissionDefinition(tx, input.submissionId, slug);
      const answers = await withKnownAnswers(tx, input.submissionId, def, input.answers as Answers);
      return saveSection(tx, ctx, {
        submissionId: input.submissionId,
        proof: { resumeToken: input.resumeToken ?? null, fsid: cookie(FSID_COOKIE), identityToken: input.identityToken ?? null },
        sectionKey: input.sectionKey,
        answers,
      });
    },
    { route: "save", slug },
  );
}
