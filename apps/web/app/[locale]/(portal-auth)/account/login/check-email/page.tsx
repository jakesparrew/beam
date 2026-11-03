import { localeFromSegment } from "@beam/core/i18n";
import { translator } from "@/lib/i18n";
import { ResendLinkForm } from "@/modules/platform/ui/login-form";

/** `/[locale]/account/login/check-email`: "the link works for 15 minutes", with a resend form (PL-11). */
export default async function CheckEmailPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ email?: string }> }) {
  const { locale: seg } = await params;
  const { email } = await searchParams;
  const locale = localeFromSegment(seg) ?? "nl-BE";
  const tr = translator(locale);
  return (
    <main id="main-content" className="mx-auto grid max-w-md gap-6 px-4 py-12">
      <h1 className="text-2xl font-semibold">{tr("platform.portal_login.check_title")}</h1>
      <p role="status">{tr("platform.portal_login.check_body")}</p>
      <ResendLinkForm
        locale={locale}
        {...(email ? { email } : {})}
        labels={{ email: tr("platform.portal_login.email"), submit: tr("platform.portal_login.resend"), sent: tr("platform.portal_login.resent") }}
      />
    </main>
  );
}
