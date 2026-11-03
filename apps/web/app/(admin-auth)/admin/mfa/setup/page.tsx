import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { adminAuthLocale, mfaSetupLabels, translator } from "@/lib/i18n";
import { SignOutButton } from "@/modules/platform/ui/login-form";
import { MfaSetup } from "@/modules/platform/ui/mfa-setup";

/** `/admin/mfa/setup`: QR code, manual key, one valid code, then the recovery codes (PL-4). */
export default async function MfaSetupPage() {
  const session = await getSession();
  if (!session || session.audience !== "staff") redirect("/admin/login");
  if (session.user.mfaEnrolledAt) redirect(session.mfaAt ? "/admin" : "/admin/mfa/verify");
  const locale = await adminAuthLocale();
  const tr = translator(locale);
  return (
    <>
      <h1 className="text-2xl font-semibold">{tr("platform.mfa.setup_title")}</h1>
      <MfaSetup labels={mfaSetupLabels(tr, locale)} email={session.user.email} />
      <SignOutButton label={tr("platform.mfa.sign_out")} variant="ghost" />
    </>
  );
}
