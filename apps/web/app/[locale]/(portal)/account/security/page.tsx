import { localeFromSegment } from "@beam/core/i18n";
import { getSession, requireCustomer } from "@/lib/auth";
import { messageTemplate, passwordLabels, translator } from "@/lib/i18n";
import { PASSWORD_RULES } from "@/lib/password";
import { SignOutButton, SignOutOthersButton } from "@/modules/platform/ui/login-form";
import { SetPasswordForm } from "@/modules/platform/ui/password-strength";

/** `/[locale]/account/security`: set or change the optional password, sign out elsewhere (PL-13). */
export default async function PortalSecurityPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: seg } = await params;
  const locale = localeFromSegment(seg) ?? "nl-BE";
  await requireCustomer(locale);
  const session = (await getSession())!;
  const tr = translator(locale);
  const hasPassword = session.user.hasPassword;
  return (
    <div className="mx-auto grid max-w-xl gap-8 p-4">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">{tr("platform.portal_security.title")}</h1>
        <p className="text-muted-foreground">{tr("platform.portal_security.intro")}</p>
      </header>
      <section aria-labelledby="password-title" className="grid gap-4">
        <h2 id="password-title" className="text-lg font-semibold">
          {tr(hasPassword ? "platform.portal_security.change_password" : "platform.portal_security.set_password")}
        </h2>
        <SetPasswordForm
          mode="change"
          askCurrent={hasPassword}
          minLength={PASSWORD_RULES.customer.minLength}
          email={session.user.email}
          labels={{
            ...passwordLabels(tr, locale),
            current: tr("platform.password.current"),
            submit: tr(hasPassword ? "platform.portal_security.change_password" : "platform.portal_security.set_password"),
            done: tr("platform.portal_security.saved"),
            wrongPassword: tr("platform.account.wrong_password"),
          }}
        />
      </section>
      <section aria-labelledby="devices-title" className="grid gap-4">
        <h2 id="devices-title" className="text-lg font-semibold">
          {tr("platform.portal_security.sessions_title")}
        </h2>
        <SignOutOthersButton label={tr("platform.portal_security.sign_out_all")} done={messageTemplate(locale, "platform.account.signed_out_others")} />
        <SignOutButton label={tr("platform.portal_security.sign_out")} />
      </section>
    </div>
  );
}
