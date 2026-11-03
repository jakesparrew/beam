import { LOCALES, URL_SEGMENT, formatDateTime } from "@beam/core/i18n";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { getSession, readMfaSecrets, requireStaff, unusedCodeCount } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { messageTemplate, mfaSetupLabels, passwordLabels, translator } from "@/lib/i18n";
import { PASSWORD_RULES } from "@/lib/password";
import { listSessions } from "@/modules/platform/queries";
import { ProfileForm, RevokeSessionButton, SignOutButton, SignOutOthersButton } from "@/modules/platform/ui/login-form";
import { RegenerateCodesForm } from "@/modules/platform/ui/mfa-setup";
import { SetPasswordForm } from "@/modules/platform/ui/password-strength";

/** `/admin/account`: own name and locale, password change, recovery codes, own sessions. */
export default async function AccountPage() {
  const actor = await requireStaff();
  const session = (await getSession())!;
  const locale = session.user.locale;
  const tr = translator(locale);
  const db = await getAppDb();
  const sessions = await listSessions(db, actor.userId);
  const codesLeft = unusedCodeCount((await readMfaSecrets(db, actor.userId)).codes);

  return (
    <div className="grid max-w-3xl gap-10">
      <h1 className="text-2xl font-semibold">{tr("platform.account.title")}</h1>

      <section aria-labelledby="profile-title" className="grid gap-4">
        <h2 id="profile-title" className="text-lg font-semibold">
          {tr("platform.account.profile_title")}
        </h2>
        <ProfileForm
          name={session.user.name ?? ""}
          locale={locale}
          locales={LOCALES.map((l) => ({ value: l, label: tr(`platform.shell.locale_${URL_SEGMENT[l]}`) }))}
          labels={{ name: tr("platform.account.name"), locale: tr("platform.account.locale"), save: tr("platform.account.save"), saved: tr("platform.account.saved"), generic: tr("platform.errors.validation") }}
        />
      </section>

      <section aria-labelledby="password-title" className="grid gap-4">
        <h2 id="password-title" className="text-lg font-semibold">
          {tr("platform.account.password_title")}
        </h2>
        <SetPasswordForm
          mode="change"
          askCurrent
          minLength={PASSWORD_RULES.staff.minLength}
          email={session.user.email}
          labels={{
            ...passwordLabels(tr, locale),
            current: tr("platform.password.current"),
            submit: tr("platform.account.change_password"),
            done: tr("platform.account.password_changed"),
            wrongPassword: tr("platform.account.wrong_password"),
          }}
        />
      </section>

      <section aria-labelledby="recovery-title" className="grid gap-4">
        <h2 id="recovery-title" className="text-lg font-semibold">
          {tr("platform.account.recovery_title")}
        </h2>
        <p>{tr("platform.shell.recovery_codes_left", { count: codesLeft })}</p>
        <p className="text-sm text-muted-foreground">{tr("platform.account.regenerate_intro")}</p>
        <RegenerateCodesForm labels={mfaSetupLabels(tr, locale)} email={session.user.email} submitLabel={tr("platform.account.regenerate")} />
      </section>

      <section aria-labelledby="sessions-title" className="grid gap-4">
        <h2 id="sessions-title" className="text-lg font-semibold">
          {tr("platform.account.sessions_title")}
        </h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tr("platform.account.sessions_device")}</TableHead>
              <TableHead>{tr("platform.account.sessions_ip")}</TableHead>
              <TableHead>{tr("platform.account.sessions_last_seen")}</TableHead>
              <TableHead>
                <span className="sr-only">{tr("platform.account.revoke")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="max-w-xs truncate">{s.userAgent ?? tr("platform.account.sessions_unknown")}</TableCell>
                <TableCell>{s.ip ?? "–"}</TableCell>
                <TableCell>{formatDateTime(s.lastSeenAt, locale, "short")}</TableCell>
                <TableCell>
                  {s.sessionToken === session.sessionToken ? tr("platform.account.sessions_current") : <RevokeSessionButton sessionId={s.id} label={tr("platform.account.revoke")} />}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <SignOutOthersButton label={tr("platform.account.sign_out_others")} done={messageTemplate(locale, "platform.account.signed_out_others")} />
        <SignOutButton label={tr("platform.shell.sign_out")} variant="default" />
      </section>
    </div>
  );
}
