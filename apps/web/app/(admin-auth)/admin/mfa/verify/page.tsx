import { redirect } from "next/navigation";
import { getSession, safeReturnTo } from "@/lib/auth";
import { adminAuthLocale, totpLabels, translator } from "@/lib/i18n";
import { SignOutButton } from "@/modules/platform/ui/login-form";
import { TotpForm } from "@/modules/platform/ui/totp-form";

/** `/admin/mfa/verify`: the 6-digit code or a recovery code (PL-3, PL-5). */
export default async function MfaVerifyPage({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) {
  const session = await getSession();
  if (!session || session.audience !== "staff") redirect("/admin/login");
  if (!session.user.mfaEnrolledAt) redirect("/admin/mfa/setup");
  const { returnTo } = await searchParams;
  const target = safeReturnTo(returnTo, "/admin");
  if (session.mfaAt) redirect(target as never);
  const locale = await adminAuthLocale();
  const tr = translator(locale);
  return (
    <>
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">{tr("platform.mfa.verify_title")}</h1>
        <p className="text-sm text-muted-foreground">{tr("platform.mfa.verify_intro")}</p>
      </header>
      <TotpForm labels={totpLabels(tr, locale)} returnTo={target} locale={locale} />
      <SignOutButton label={tr("platform.mfa.sign_out")} variant="ghost" />
    </>
  );
}
