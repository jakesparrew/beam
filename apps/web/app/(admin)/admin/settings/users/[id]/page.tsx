import Link from "next/link";
import { notFound } from "next/navigation";
import { ROLE_KEYS } from "@beam/db/schema";
import { Badge, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { catalogueSection, getStaffUser } from "@/modules/platform/queries";
import { RevokeSessionButton, UserAccountControls, UserProfileForm } from "@/modules/platform/ui/user-form";

/**
 * `/admin/settings/users/[id]` (`users.manage`): profile, role, tester switch, status, MFA state,
 * sessions and the last 20 audit rows about this user. The server enforces the owner rules (PL-16).
 */
export default async function StaffUserPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireStaff({ permission: "users.manage" });
  const { id } = await params;
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string, p?: Record<string, string | number>) => tr(`platform.users.${k}`, p);
  const user = await getStaffUser(await getAppDb(), id);
  if (!user) notFound();
  const labels = catalogueSection(locale, "platform.users");
  const errors = catalogueSection(locale, "platform.errors");
  const when = (d: Date | string | null) => (d ? new Date(d).toLocaleString(locale, { timeZone: "Europe/Brussels", dateStyle: "short", timeStyle: "short" }) : "–");
  const locked = !!user.lockedUntil && user.lockedUntil.getTime() > new Date().getTime();
  // Only an owner may change a user to or from owner (PL-16).
  const roleChoices = actor.roleKey === "owner" ? ROLE_KEYS : user.roleKey === "owner" ? (["owner"] as const) : ROLE_KEYS.filter((k) => k !== "owner");
  const roles = roleChoices.map((k) => ({ key: k, label: tr(`platform.roles.${k}`) }));
  const editable = {
    id: user.id,
    name: user.name,
    email: user.email,
    locale: user.locale,
    roleKey: user.roleKey,
    isTester: user.isTester,
    status: user.status,
    locked,
    invitePending: user.invitePending,
    mfaEnrolled: !!user.mfaEnrolledAt,
  };

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <Link href="/admin/settings/users" className="text-sm text-muted-foreground hover:underline">
          {t("back")}
        </Link>
        <h1 className="text-2xl font-semibold">{user.name ?? user.email}</h1>
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{user.email}</span>
          <Badge variant={user.status === "active" ? "secondary" : "destructive"}>{t(`status_${user.status}`)}</Badge>
          {user.mfaEnrolledAt ? <Badge variant="success">{t("mfa_on")}</Badge> : <Badge variant="warning">{t("mfa_off")}</Badge>}
          {locked ? <Badge variant="destructive">{t("locked_until", { when: when(user.lockedUntil) })}</Badge> : null}
          {user.invitePending ? <Badge variant="outline">{t("invite_pending")}</Badge> : null}
          <span>{t("last_login", { when: when(user.lastLoginAt) })}</span>
        </p>
      </header>
      <section className="grid gap-3" aria-labelledby="profile">
        <h2 id="profile" className="text-lg font-medium">
          {t("profile")}
        </h2>
        <UserProfileForm user={editable} roles={roles} labels={labels} errors={errors} />
      </section>
      <section className="grid gap-3" aria-labelledby="account">
        <h2 id="account" className="text-lg font-medium">
          {t("account_controls")}
        </h2>
        <UserAccountControls user={editable} labels={labels} errors={errors} />
      </section>
      <section className="grid gap-3" aria-labelledby="sessions">
        <h2 id="sessions" className="text-lg font-medium">
          {t("sessions")}
        </h2>
        {user.sessions.length === 0 ? (
          <EmptyState title={t("no_sessions")} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("col_device")}</TableHead>
                <TableHead>{t("col_ip")}</TableHead>
                <TableHead>{t("col_created")}</TableHead>
                <TableHead>{t("col_last_seen")}</TableHead>
                <TableHead>{t("col_mfa")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("revoke")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {user.sessions.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="max-w-64 truncate">{s.userAgent ?? "–"}</TableCell>
                  <TableCell>{s.ip ?? "–"}</TableCell>
                  <TableCell>{when(s.createdAt)}</TableCell>
                  <TableCell>{when(s.lastSeenAt)}</TableCell>
                  <TableCell>{s.mfaAt ? t("mfa_on") : t("mfa_pending")}</TableCell>
                  <TableCell>
                    <RevokeSessionButton sessionId={s.id} labels={labels} errors={errors} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      <section className="grid gap-3" aria-labelledby="audit">
        <h2 id="audit" className="text-lg font-medium">
          {t("audit")}
        </h2>
        {user.audit.length === 0 ? (
          <EmptyState title={t("no_audit")} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("col_when")}</TableHead>
                <TableHead>{t("col_action")}</TableHead>
                <TableHead>{t("col_actor")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {user.audit.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>{when(a.createdAt)}</TableCell>
                  <TableCell className="font-mono text-xs">{a.action}</TableCell>
                  <TableCell className="font-mono text-xs">{(a.actor as { kind: string; id?: string | null }).id ?? (a.actor as { kind: string }).kind}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Link href={`/admin/system/audit?entityType=users&entityId=${user.id}`} className="text-sm hover:underline">
          {t("open_audit")}
        </Link>
      </section>
    </div>
  );
}
