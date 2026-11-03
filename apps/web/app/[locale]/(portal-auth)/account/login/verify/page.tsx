import { redirect } from "next/navigation";
import { localeFromSegment, URL_SEGMENT } from "@beam/core/i18n";
import { Button } from "@beam/ui";
import { safeReturnTo } from "@/lib/auth";
import { EMAIL_PROVIDER_ID } from "@/lib/auth-config";
import { translator } from "@/lib/i18n";

function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"•".repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}

/**
 * `/[locale]/account/login/verify`: the target of the emailed link. A button submits to the
 * Auth.js Email callback, so mail scanners that prefetch links do not consume the token
 * (edge case 12). Missing parameters go back to the login page.
 */
export default async function VerifyPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ token?: string; email?: string; callbackUrl?: string }>;
}) {
  const { locale: seg } = await params;
  const { token, email, callbackUrl } = await searchParams;
  const locale = localeFromSegment(seg) ?? "nl-BE";
  const home = `/${URL_SEGMENT[locale]}/account`;
  if (!token || !email) redirect(`${home}/login` as never);
  const tr = translator(locale);
  return (
    <main id="main-content" className="mx-auto grid max-w-md gap-6 px-4 py-12">
      <h1 className="text-2xl font-semibold">{tr("platform.portal_login.verify_title")}</h1>
      <p>{tr("platform.portal_login.verify_body", { email: maskEmail(email) })}</p>
      <form method="get" action={`/api/auth/callback/${EMAIL_PROVIDER_ID}`}>
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="callbackUrl" value={safeReturnTo(callbackUrl, home)} />
        <Button type="submit">{tr("platform.portal_login.verify_submit")}</Button>
      </form>
    </main>
  );
}
