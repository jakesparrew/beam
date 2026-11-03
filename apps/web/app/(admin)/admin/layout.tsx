import type { ReactNode } from "react";
import Link from "next/link";
import { headers } from "next/headers";
import type { RoleKey } from "@beam/db/schema";
import { Alert, AlertDescription, type NavSection } from "@beam/ui";
import { getSession, hasPermission, readMfaSecrets, requireStaff, unusedCodeCount } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { reportProblemLabels, softTranslator, translator } from "@/lib/i18n";
import { getSetting } from "@/lib/settings";
import { RECOVERY_CODES_LOW } from "@beam/core/platform";
import { AdminFrame } from "@/modules/platform/ui/login-form";
import { NAV } from "@/registry/nav.generated";
import type { Permission } from "@/registry/types.generated";

type AdminNavEntry = { key: string; section: string; labelKey: string; href: string; permission?: string; icon: string; order: number };

/**
 * The staff shell (platform spec 5): `requireStaff()`, then `AdminShell` with the sidebar from
 * the generated nav, filtered by the same `hasPermission()` that `action()` uses (PL-19),
 * the user menu with "Report a problem" and "Sign out", the tester badge and the
 * low-recovery-codes banner (PL-5).
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const actor = await requireStaff();
  const session = (await getSession())!;
  const locale = session.user.locale;
  const tr = translator(locale);
  const soft = softTranslator(locale);
  const db = await getAppDb();

  const visible = (NAV.admin as readonly AdminNavEntry[]).filter((e) => !e.permission || hasPermission(actor, e.permission as Permission));
  const sections = new Map<string, AdminNavEntry[]>();
  for (const e of [...visible].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))) {
    sections.set(e.section, [...(sections.get(e.section) ?? []), e]);
  }
  const nav: NavSection[] = [...sections.entries()].map(([section, items]) => ({
    key: section,
    label: soft(`platform.nav.section_${section}`) === `platform.nav.section_${section}` ? section : soft(`platform.nav.section_${section}`),
    items: items.map((i) => ({ key: i.key, href: i.href, label: soft(i.labelKey), icon: i.icon })),
  }));

  const secrets = await readMfaSecrets(db, actor.userId).catch(() => null);
  const codesLeft = secrets ? unusedCodeCount(secrets.codes) : null;
  const support = (await getSetting(db, "support")) as { emergency_phone: string };
  const pathname = ((await headers()).get("x-pathname") ?? "/admin").split("?")[0]!;
  const roleLabel = soft(`platform.roles.${actor.roleKey satisfies RoleKey}`);

  const banner =
    codesLeft !== null && codesLeft <= RECOVERY_CODES_LOW ? (
      <Alert role="status">
        <AlertDescription>
          {tr("platform.shell.recovery_codes_low", { count: codesLeft })} <Link href="/admin/account">{tr("platform.shell.open_account")}</Link>
        </AlertDescription>
      </Alert>
    ) : undefined;

  return (
    <AdminFrame
      nav={nav}
      user={{ name: session.user.name ?? session.user.email, email: session.user.email, isTester: session.user.isTester, ...(roleLabel.startsWith("platform.") ? {} : { roleLabel }) }}
      banner={banner}
      currentPath={pathname}
      labels={{
        skipToContent: tr("platform.shell.skip_to_content"),
        navigation: tr("platform.shell.navigation"),
        openNavigation: tr("platform.shell.open_navigation"),
        closeNavigation: tr("platform.shell.close_navigation"),
        userMenu: tr("platform.shell.user_menu"),
        reportProblem: tr("platform.shell.report_problem"),
        signOut: tr("platform.shell.sign_out"),
        tester: tr("platform.shell.tester"),
        brand: tr("platform.shell.brand"),
      }}
      reportLabels={reportProblemLabels(tr, locale)}
      emergencyPhone={support.emergency_phone}
    >
      {children}
    </AdminFrame>
  );
}
