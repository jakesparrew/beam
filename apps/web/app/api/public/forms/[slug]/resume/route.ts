/**
 * `GET /api/public/forms/[slug]/resume?token=` (forms spec section 4, rule U5):
 * `{ submissionId, answers (non-sensitive), currentSectionKey }` or `404`. An abandoned
 * submission within its resume window becomes `partial` again; its `form.abandoned` event stays.
 * Sensitive answers are never returned: the browser asks them again. Refreshes the `fsid` cookie.
 */
import { NotFoundError } from "@/lib/ctx";
import { resumeSubmission } from "@/modules/forms/service/submissions";
import { fsidCookie, handlePublic } from "@/modules/forms/ui/public/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params;
  const token = new URL(req.url).searchParams.get("token") ?? "";
  return handlePublic(
    req,
    async ({ tx, ctx, setCookie }) => {
      if (!token || token.length > 200) throw new NotFoundError("submission_not_found");
      const r = await resumeSubmission(tx, ctx, { slug, token });
      if (!r) throw new NotFoundError("submission_not_found");
      setCookie(fsidCookie(r.submissionId));
      return r;
    },
    { route: "resume", slug, body: false },
  );
}
