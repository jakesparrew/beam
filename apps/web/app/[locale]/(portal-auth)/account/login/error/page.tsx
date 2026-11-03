import Link from "next/link";
import { localeFromSegment, URL_SEGMENT } from "@beam/core/i18n";
import { translator } from "@/lib/i18n";
import { ResendLinkForm } from "@/modules/platform/ui/login-form";

/** `/[locale]/account/login/error`: expired or used link, staff address (PL-12) or a refused account. */
export default async function LoginErrorPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ error?: string }> }) {
  const { locale: seg } = await params;
  const { error } = await searchParams;
  const locale = localeFromSegment(seg) ?? "nl-BE";
  const tr = translator(locale);
  const body =
    error === "StaffEmail" ? tr("platform.portal_login.error_staff") : error === "AccessDenied" ? tr("platform.portal_login.error_denied") : tr("platform.portal_login.error_body");
  return (
    <main id="main-content" className="mx-auto grid max-w-md gap-6 px-4 py-12">
      <h1 className="text-2xl font-semibold">{tr("platform.portal_login.error_title")}</h1>
      <p role="alert">{body}</p>
      <ResendLinkForm locale={locale} labels={{ email: tr("platform.portal_login.email"), submit: tr("platform.portal_login.resend"), sent: tr("platform.portal_login.resent") }} />
      <Link href={`/${URL_SEGMENT[locale]}/account/login` as never} className="text-sm underline">
        {tr("platform.portal_login.back")}
      </Link>
    </main>
  );
}
