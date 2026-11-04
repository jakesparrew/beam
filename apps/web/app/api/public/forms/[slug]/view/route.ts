/**
 * `POST /api/public/forms/[slug]/view` (forms spec section 4): `{ locale, linkKey? }` -> `204`.
 * Counts one page view of a published form in `form_views_daily` (Europe/Brussels day, link key
 * or `''`, locale) with `insert ... on conflict do update set views = views + 1`. No personal
 * data. An unknown, draft or unavailable form answers `404`, an archived one `410`.
 */
import { z } from "zod";
import { brusselsDay } from "@beam/core/forms";
import { LOCALES } from "@beam/core/i18n";
import { formViewsDaily } from "@beam/db/schema";
import { NotFoundError, sql } from "@/lib/ctx";
import { loadPublishedForm } from "@/modules/forms/service/submissions";
import { handlePublic, NO_STORE, parseBody } from "@/modules/forms/ui/public/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  locale: z.enum(LOCALES),
  linkKey: z
    .string()
    .regex(/^[a-z0-9]{1,16}$/)
    .optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params;
  return handlePublic(
    req,
    async ({ tx, ctx, body }) => {
      const input = parseBody(Body, body);
      const { form, versionRow } = await loadPublishedForm(tx, slug);
      if (!versionRow.locales.includes(input.locale)) throw new NotFoundError("unavailable_locale");
      await tx
        .insert(formViewsDaily)
        .values({ formId: form.id, dayOn: brusselsDay(ctx.now), linkKey: input.linkKey ?? "", locale: input.locale, views: 1 })
        .onConflictDoUpdate({
          target: [formViewsDaily.formId, formViewsDaily.dayOn, formViewsDaily.linkKey, formViewsDaily.locale],
          set: { views: sql`${formViewsDaily.views} + 1`, updatedAt: ctx.now },
        });
      return new Response(null, { status: 204, headers: NO_STORE });
    },
    { route: "view", slug },
  );
}
