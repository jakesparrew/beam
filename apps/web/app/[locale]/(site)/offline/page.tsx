import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { localeFromSegment } from "@beam/core/i18n";
import { localePath } from "@beam/core/site";
import { translator } from "@/lib/i18n";
import { noindexMetadata } from "@/modules/site/server/metadata";

/**
 * The offline fallback (site spec sections 4 and 5, site-P5): precached by the service worker
 * for `/nl/offline`, `/fr/offline` and `/en/offline` and served when a navigation fails without
 * network. No data reads of its own, so the cached copy stays valid.
 */
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = localeFromSegment((await params).locale);
  return noindexMetadata(locale ? translator(locale)("site.public.offline.title") : "Offline");
}

export default async function OfflinePage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = localeFromSegment((await params).locale);
  if (!locale) notFound();
  const tr = translator(locale);
  return (
    <section className="mx-auto flex max-w-xl flex-col items-center gap-4 px-4 py-24 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">{tr("site.public.offline.title")}</h1>
      <p className="text-muted-foreground">{tr("site.public.offline.body")}</p>
      <a href={localePath(locale, "")} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
        {tr("site.public.notFound.home")}
      </a>
    </section>
  );
}
