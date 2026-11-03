import Link from "next/link";
import { adminAuthLocale, passwordLabels, translator } from "@/lib/i18n";
import { PASSWORD_RULES } from "@/lib/password";
import { SetPasswordForm } from "@/modules/platform/ui/password-strength";

/** `/admin/reset-password/[token]`: set a new password; an expired or used token says so. */
export default async function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const locale = await adminAuthLocale();
  const tr = translator(locale);
  return (
    <>
      <h1 className="text-2xl font-semibold">{tr("platform.reset.set_title")}</h1>
      <SetPasswordForm mode="reset" token={token} minLength={PASSWORD_RULES.staff.minLength} labels={{ ...passwordLabels(tr, locale), submit: tr("platform.reset.set_submit") }} />
      <Link href="/admin/login" className="text-sm underline">
        {tr("platform.reset.back_to_login")}
      </Link>
    </>
  );
}
