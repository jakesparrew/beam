import { sql } from "@/lib/ctx";
import { getAppDb } from "@/lib/ctx";
import { hashVerificationToken } from "@/lib/auth";
import { adminAuthLocale, passwordLabels, translator } from "@/lib/i18n";
import { PASSWORD_RULES } from "@/lib/password";
import { rowsOf } from "@/lib/sensitive";
import { SetPasswordForm } from "@/modules/platform/ui/password-strength";

/** `/admin/invite/[token]`: set the first password (PL-10), then MFA setup. */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const locale = await adminAuthLocale();
  const tr = translator(locale);
  const rows = rowsOf<{ ok: boolean }>(
    await (await getAppDb()).execute(
      sql`select (expires_at > now()) as ok from auth_verification_tokens where token = ${hashVerificationToken(token)} and identifier like 'staff-invite:%'`,
    ),
  );
  if (!rows[0]?.ok) {
    return (
      <>
        <h1 className="text-2xl font-semibold">{tr("platform.invite.title")}</h1>
        <p role="alert">{tr("platform.invite.invalid")}</p>
      </>
    );
  }
  return (
    <>
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">{tr("platform.invite.title")}</h1>
        <p className="text-sm text-muted-foreground">{tr("platform.invite.intro")}</p>
      </header>
      <SetPasswordForm
        mode="invite"
        token={token}
        minLength={PASSWORD_RULES.staff.minLength}
        labels={{ ...passwordLabels(tr, locale), submit: tr("platform.invite.submit"), invalidToken: tr("platform.invite.invalid") }}
      />
    </>
  );
}
