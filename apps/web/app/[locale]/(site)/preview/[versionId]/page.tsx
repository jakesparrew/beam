import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { formatDateTime, localeFromSegment } from "@beam/core/i18n";
import { actorFromSession, getSession, hasPermission } from "@/lib/auth";
import { translator } from "@/lib/i18n";
import { getPreviewPage } from "@/modules/site/queries";
import { noindexMetadata } from "@/modules/site/server/metadata";
import { loadRenderData } from "@/modules/site/server/render-data";
import { PageView } from "@/modules/site/ui/public/page-view";
import { PreviewRibbon } from "@/modules/site/ui/public/preview-ribbon";

/**
 * Staff preview of any page version (site spec section 4): a staff session with `site.edit`
 * after MFA, otherwise 404; never indexed and never cached (it reads the session cookie, so the
 * response is dynamic and private).
 */
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string; versionId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const locale = localeFromSegment((await params).locale) ?? "nl-BE";
  return noindexMetadata(translator(locale)("site.public.preview.ribbon"));
}

export default async function PreviewPage({ params, searchParams }: Props) {
  const { locale: segment, versionId } = await params;
  const locale = localeFromSegment(segment);
  if (!locale || !UUID_RE.test(versionId)) notFound();
  const session = await getSession();
  const actor = actorFromSession(session);
  if (!session || !actor || actor.kind !== "staff" || !session.mfaAt || !hasPermission(actor, "site.edit")) notFound();
  const page = await getPreviewPage(versionId, locale);
  if (!page) notFound();
  const tr = translator(locale);
  const data = await loadRenderData(page, await searchParams);
  return (
    <>
      <PreviewRibbon label={tr("site.public.preview.ribbon")} detail={`v${page.version}${page.publishedAt ? ` · ${formatDateTime(page.publishedAt, locale)}` : ""}`} />
      <PageView page={page} data={data} tr={tr} />
    </>
  );
}
