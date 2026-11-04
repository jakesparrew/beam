import type { ReactNode } from "react";
import Link from "next/link";
import { headers } from "next/headers";
import type { RoleKey } from "@beam/db/schema";
import { Alert, AlertDescription, type NavSection } from "@beam/ui";
import { RECOVERY_CODES_LOW } from "@beam/core/platform";
import { getSession, hasPermission, readMfaSecrets, requireStaff, unusedCodeCount } from "@/lib/auth";
import { getAppDb, type Actor, type DbOrTx } from "@/lib/ctx";
import { flag } from "@/lib/flags";
import { reportProblemLabels, softTranslator, translator } from "@/lib/i18n";
import { appEnv } from "@/lib/integrations";
import { getSetting } from "@/lib/settings";
import { isGoLiveGateComplete } from "@/modules/platform/api";
import { AdminFrame } from "@/modules/platform/ui/support-form";
import { NAV } from "@/registry/nav.generated";
import type { FlagKey, Permission } from "@/registry/types.generated";

type StaffActor = Extract<Actor, { kind: "staff" }>;

/** The entry contract of `modules/*/nav.ts` (see `modules/platform/nav.ts`). */
type AdminNavEntry = {
  key: string;
  section: string;
  labelKey: string;
  href: string;
  permission?: string;
  flag?: string;
  icon: string;
  order: number;
  badge?: (input: { db: DbOrTx; actor: StaffActor }) => Promise<number>;
};

/** A badge that throws or takes longer than this is left out; the shell never waits on it. */
const BADGE_TIMEOUT_MS = 800;

async function badgeCount(entry: AdminNavEntry, db: DbOrTx, actor: StaffActor): Promise<number | null> {
  if (!entry.badge) return null;
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), BADGE_TIMEOUT_MS));
  const count = entry.badge({ db, actor }).catch(() => null);
  const n = await Promise.race([count, timeout]);
  return typeof n === "number" && n > 0 ? n : null;
}

/** Entries the actor may open: permission (PL-19) and flag (PL-43, off unless on for the actor). */
async function visibleEntries(actor: StaffActor): Promise<AdminNavEntry[]> {
  const entries = (NAV.admin as readonly AdminNavEntry[]).filter((e) => !e.permission || hasPermission(actor, e.permission as Permission));
  const flagged = await Promise.all(entries.map(async (e) => (!e.flag ? true : await flag(e.flag as FlagKey, actor).catch(() => false))));
  return entries.filter((_, i) => flagged[i]).sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

/** `platform.nav.section_<key>`, else the key with a capital (a module may add a section before its label exists). */
function sectionLabel(soft: (key: string) => string, section: string): string {
  const key = `platform.nav.section_${section}`;
  const label = soft(key);
  return label === key ? section.charAt(0).toUpperCase() + section.slice(1).replace(/_/g, " ") : label;
}

/**
 * The staff shell (platform spec 5): `requireStaff()`, then `AdminShell` with the sidebar from
 * the generated nav, filtered by the same `hasPermission()` that `action()` uses (PL-19) and by
 * each entry's flag, section labels from the platform catalogue, entry badges, the user menu
 * with "Report a problem" and "Sign out", the tester badge, the low-recovery-codes banner (PL-5)
 * and the red go-live banner while the gate is incomplete in production (PL-77).
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const actor = await requireStaff();
  const session = (await getSession())!;
  const locale = session.user.locale;
  const tr = translator(locale);
  const soft = softTranslator(locale);
  const db = await getAppDb();

  const entries = await visibleEntries(actor);
  const badges = await Promise.all(entries.map((e) => badgeCount(e, db, actor)));
  const sections = new Map<string, NavSection["items"]>();
  entries.forEach((e, i) => {
    const n = badges[i];
    const label = soft(e.labelKey);
    sections.set(e.section, [...(sections.get(e.section) ?? []), { key: e.key, href: e.href, label: n ? tr("platform.nav.with_badge", { label, count: n }) : label, icon: e.icon }]);
  });
  const nav: NavSection[] = [...sections.entries()].map(([section, items]) => ({ key: section, label: sectionLabel(soft, section), items }));

  const secrets = await readMfaSecrets(db, actor.userId).catch(() => null);
  const codesLeft = secrets ? unusedCodeCount(secrets.codes) : null;
  const support = (await getSetting(db, "support")) as { emergency_phone: string };
  const pathname = ((await headers()).get("x-pathname") ?? "/admin").split("?")[0]!;
  const roleLabel = soft(`platform.roles.${actor.roleKey satisfies RoleKey}`);
  const gateOpen = appEnv() === "production" && !(await isGoLiveGateComplete(db).catch(() => false));

  const banners: ReactNode[] = [];
  if (gateOpen) {
    banners.push(
      <Alert key="gate" variant="destructive" role="status">
        <AlertDescription>
          {tr("platform.shell.go_live_incomplete")} <Link href="/admin/system/go-live">{tr("platform.shell.open_go_live")}</Link>
        </AlertDescription>
      </Alert>,
    );
  }
  if (codesLeft !== null && codesLeft <= RECOVERY_CODES_LOW) {
    banners.push(
      <Alert key="codes" role="status">
        <AlertDescription>
          {tr("platform.shell.recovery_codes_low", { count: codesLeft })} <Link href="/admin/account">{tr("platform.shell.open_account")}</Link>
        </AlertDescription>
      </Alert>,
    );
  }

  return (
    <AdminFrame
      nav={nav}
      user={{ name: session.user.name ?? session.user.email, email: session.user.email, isTester: session.user.isTester, ...(roleLabel.startsWith("platform.") ? {} : { roleLabel }) }}
      banner={banners.length ? <div className="grid gap-2">{banners}</div> : undefined}
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
