import { Badge, Card, CardContent, CardHeader, CardTitle, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { catalogueSection, getSecurityStatus } from "@/modules/platform/queries";
import { PentestForm, RekeyButton } from "@/modules/platform/ui/pentest-form";

/** The blueprint-64 safeguards; each has one implementation and one proof in `docs/runbooks/security-controls.md` (PL-83). */
const SAFEGUARDS = ["encryption_transit", "encryption_rest", "mfa", "rbac", "passwords", "logging", "backup", "api", "rate_limiting", "vulnerability_testing", "dependencies", "secrets"] as const;

/**
 * `/admin/system/security` (`system.jobs`): key versions in use (rows per version per table), MFA
 * coverage, locked accounts, the last backup and restore drill (written by `record-backup.ts`), the
 * last and next ethical-hacking test and the safeguard list. `startRekey` is owner only (PL-70);
 * `recordPentest` is for owner or technical_admin (PL-85).
 */
export default async function SecurityPage() {
  const actor = await requireStaff({ permission: "system.jobs" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string, p?: Record<string, string | number>) => tr(`platform.security.${k}`, p);
  const s = await getSecurityStatus(await getAppDb());
  const labels = catalogueSection(locale, "platform.security");
  const errors = catalogueSection(locale, "platform.errors");
  const when = (v: string | Date | null) => (v ? new Date(v).toLocaleString(locale, { timeZone: "Europe/Brussels", dateStyle: "short", timeStyle: "short" }) : "–");
  const dateOnly = (v: string | null) => (v ? new Date(`${v}T12:00:00Z`).toLocaleDateString(locale, { timeZone: "Europe/Brussels" }) : "–");
  const okBadge = (ok: boolean | null) => (ok === null ? null : <Badge variant={ok ? "success" : "destructive"}>{t(ok ? "ok" : "failed")}</Badge>);
  const isAdmin = actor.roleKey === "owner" || actor.roleKey === "technical_admin";
  const behind = s.versions.filter((v) => v.keyVersion < s.currentKeyVersion).reduce((n, v) => n + v.rows, 0);

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("intro")}</p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">{t("mfa_coverage")}</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {s.mfa.enrolled} / {s.mfa.total}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">{t("last_backup")}</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-2 text-sm">
            {when(s.lastBackupAt)} {okBadge(s.lastBackupOk)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">{t("last_restore_drill")}</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-2 text-sm">
            {when(s.lastRestoreDrillAt)} {okBadge(s.lastRestoreDrillOk)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">{t("pentest")}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1 text-sm">
            <p>{t("last_pentest", { date: dateOnly(s.lastPentestOn) })}</p>
            <p>{t("next_pentest", { date: dateOnly(s.nextPentestDueOn) })}</p>
          </CardContent>
        </Card>
      </div>
      <section className="grid gap-3" aria-labelledby="keys">
        <h2 id="keys" className="text-lg font-medium">
          {t("key_versions", { version: s.currentKeyVersion })}
        </h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("col_table")}</TableHead>
              <TableHead>{t("col_key_version")}</TableHead>
              <TableHead>{t("col_rows")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {s.versions.map((v) => (
              <TableRow key={`${v.table}-${v.keyVersion}`}>
                <TableCell className="font-mono text-xs">{v.table}</TableCell>
                <TableCell>{v.keyVersion < s.currentKeyVersion ? <Badge variant="warning">{v.keyVersion}</Badge> : v.keyVersion}</TableCell>
                <TableCell>{v.rows}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {behind > 0 ? <p className="text-sm text-muted-foreground">{t("rows_behind", { count: behind })}</p> : null}
      </section>
      <section className="grid gap-3" aria-labelledby="locked">
        <h2 id="locked" className="text-lg font-medium">
          {t("locked_accounts")}
        </h2>
        {s.locked.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("no_locked")}</p>
        ) : (
          <ul className="grid gap-1 text-sm">
            {s.locked.map((u) => (
              <li key={u.id}>
                {u.name ?? u.email} · {t("locked_until", { when: when(u.lockedUntil) })}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="grid gap-3" aria-labelledby="safeguards">
        <h2 id="safeguards" className="text-lg font-medium">
          {t("safeguards")}
        </h2>
        <ul className="grid gap-1 text-sm">
          {SAFEGUARDS.map((g) => (
            <li key={g}>
              {t(`safeguard_${g}`)} <code className="text-xs">docs/runbooks/security-controls.md#{g.replace(/_/g, "-")}</code>
            </li>
          ))}
        </ul>
      </section>
      {isAdmin ? <PentestForm labels={labels} errors={errors} /> : null}
      {actor.roleKey === "owner" ? <RekeyButton toVersion={s.currentKeyVersion + 1} labels={labels} errors={errors} /> : null}
    </div>
  );
}
