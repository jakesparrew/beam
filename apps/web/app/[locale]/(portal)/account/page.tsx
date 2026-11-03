/**
 * Customer account home: Wave 0 placeholder by platform-P7. site replaces it in Wave 1 with the
 * portal home (upcoming bookings, open offers, packages, membership). The portal layout of
 * platform-P6 (`requireCustomer()` + `PortalShell`) wraps it.
 */
import { notFound } from "next/navigation";
import { localeFromSegment, t } from "@beam/core/i18n";

export default async function AccountHomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  return (
    <section aria-labelledby="account-home-title">
      <h1 id="account-home-title">{t(locale, "site.account_placeholder.title")}</h1>
      <p>{t(locale, "site.account_placeholder.body")}</p>
    </section>
  );
}
