import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LOCALES, localeFromSegment } from "@beam/core/i18n";
import { localePath } from "@beam/core/site";
import { LocaleUnavailable } from "@beam/ui";
import { translator } from "@/lib/i18n";
import { getPageAlternates } from "@/modules/site/queries";
import { noindexMetadata } from "@/modules/site/server/metadata";

/**
 * "This page is not available in <language>" with links to the page's live locales
 * (`?page=<pageId>`, site spec section 5 and edge case 16); never indexed, no fallback language.
 */
type Props = { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const locale = localeFromSegment((await params).locale) ?? "nl-BE";
  const tr = translator(locale);
  return noindexMetadata(tr("site.public.unavailable.title", { language: tr(`site.public.languages.${locale}`) }));
}

export default async function UnavailablePage({ params, searchParams }: Props) {
  const locale = localeFromSegment((await params).locale);
  if (!locale) notFound();
  const raw = (await searchParams).page;
  const pageId = Array.isArray(raw) ? raw[0] : raw;
  if (!pageId || !UUID_RE.test(pageId)) notFound();
  const page = await getPageAlternates(pageId);
  if (!page) notFound();
  const tr = translator(locale);
  const alternatives = LOCALES.filter((l) => l !== locale && page.routes[l] !== undefined).map((l) => ({
    locale: l,
    label: `${translator(l)(`site.public.languages.${l}`)}${page.titles[l] ? `: ${page.titles[l]}` : ""}`,
    href: localePath(l, page.routes[l]!),
  }));
  if (!alternatives.length && page.routes[locale] === undefined) notFound();
  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <LocaleUnavailable
        title={tr("site.public.unavailable.title", { language: tr(`site.public.languages.${locale}`) })}
        description={tr("site.public.unavailable.body")}
        alternatives={alternatives}
        alternativesLabel={tr("site.public.localeSwitch.label")}
      />
    </div>
  );
}
