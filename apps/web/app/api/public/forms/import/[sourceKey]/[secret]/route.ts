/**
 * `POST /api/public/forms/import/[sourceKey]/[secret]` (forms spec section 4, rule I1): the
 * ScoreApp or Typeform webhook. The sha256 of `secret` must equal the source's `token_hash`
 * (constant-time compare) and the source must be active, else `404` and nothing is stored. The
 * raw body is stored with `on conflict (source_id, external_id) do nothing`; `forms.process_import`
 * is enqueued only for a new row and runs after the response, so the answer is a fast `200`
 * `{ ok: true }` for a new and for a duplicate delivery alike. The shared plumbing applies the
 * per-IP limit and the 64 KB body limit (R1, R4).
 */
import { receiveImport } from "@/modules/forms/service/import";
import { handlePublic } from "@/modules/forms/ui/public/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ sourceKey: string; secret: string }> }): Promise<Response> {
  const { sourceKey, secret } = await params;
  return handlePublic(
    req,
    async ({ tx, ctx, body }) => {
      await receiveImport(tx, ctx, { sourceKey, secret, payload: body });
      return { ok: true };
    },
    { route: "import" },
  );
}
