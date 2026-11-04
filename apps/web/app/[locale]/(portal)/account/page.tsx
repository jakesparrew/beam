/**
 * The portal home `/[locale]/account` (site rule 47, section 5; site-P6). The portal layout has
 * already checked the customer session; the page reads it again for the person id (the layout
 * cannot pass props). Uncached and personal (`private, no-store` through the dynamic session
 * read); each card fails on its own, so the page always answers 200.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { localeFromSegment } from "@beam/core/i18n";
import { requireCustomer } from "@/lib/auth";
import { translator } from "@/lib/i18n";
import { getAccountHome } from "@/modules/site/queries";
import { AccountHome } from "@/modules/site/ui/portal/account-home";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = localeFromSegment((await params).locale);
  if (!locale) return {};
  return { title: translator(locale)("site.portal.nav.home"), robots: { index: false, follow: false } };
}

export default async function AccountHomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  const home = await getAccountHome(actor.personId, locale);
  return <AccountHome locale={locale} home={home} tr={translator(locale)} />;
}
