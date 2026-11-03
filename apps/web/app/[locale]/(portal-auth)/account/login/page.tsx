import { localeFromSegment, URL_SEGMENT } from "@beam/core/i18n";
import { safeReturnTo } from "@/lib/auth";
import { portalLoginLabels, translator } from "@/lib/i18n";
import { PortalLoginForm } from "@/modules/platform/ui/login-form";

/** `/[locale]/account/login`: magic link by email (PL-11), or the optional password (PL-13). */
export default async function PortalLoginPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ returnTo?: string }> }) {
  const { locale: seg } = await params;
  const { returnTo } = await searchParams;
  const locale = localeFromSegment(seg) ?? "nl-BE";
  const tr = translator(locale);
  const target = returnTo ? safeReturnTo(returnTo, `/${URL_SEGMENT[locale]}/account`) : undefined;
  return (
    <main id="main-content" className="mx-auto grid max-w-md gap-6 px-4 py-12">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">{tr("platform.portal_login.title")}</h1>
        <p className="text-muted-foreground">{tr("platform.portal_login.intro")}</p>
      </header>
      <PortalLoginForm labels={portalLoginLabels(tr, locale)} locale={locale} seg={URL_SEGMENT[locale]} {...(target ? { returnTo: target } : {})} />
    </main>
  );
}
