import type { ReactNode } from "react";
import Link from "next/link";
import { headers } from "next/headers";
import { Alert, AlertDescription, type NavSection } from "@beam/ui";
import { RECOVERY_CODES_LOW } from "@beam/core/platform";
import { LOCALES, URL_SEGMENT } from "@beam/core/i18n";
import { getSession, hasPermission, readMfaSecrets, requireStaff, unusedCodeCount } from "@/lib/auth";
import { devSkipMfa } from "@/lib/auth-config";
import { getAppDb, type Actor, type DbOrTx } from "@/lib/ctx";
import { flag } from "@/lib/flags";
import { reportProblemLabels, softTranslator, translator } from "@/lib/i18n";
import { appEnv } from "@/lib/integrations";
import { getSetting } from "@/lib/settings";
import { isGoLiveGateComplete } from "@/modules/platform/api";
import { getRoleLabel } from "@/modules/platform/queries";
import { AdminLocaleSwitch } from "@/modules/platform/ui/locale-switch";
import { AdminFrame } from "@/modules/platform/ui/support-form";
import { NAV } from "@/registry/nav.generated";
import type { FlagKey, Permission } from "@/registry/types.generated";

type StaffActor = Extract<Actor, { kind: "staff" }>;

// The entry contract of `modules/<m>/nav.ts` (see `modules/platform/nav.ts`).
type AdminNavEntry = {
  key: string;
  section: string;
  labelKey: string;
  href: string;
  permission?: string;
  /** A second permission that also opens the entry (the dashboard: `reports.read` or `tasks.all`). */
  orPermission?: string;
  flag?: string;
  icon: string;
  order: number;
  badge?: (input: { db: DbOrTx; actor: StaffActor }) => Promise<number>;
};

/**
 * The sidebar: one row per group, in this order, each linking to its `main` entry with the
 * group's other entries folding out below it. A module entry lands in the group that lists its
 * section (or its key in `keys`); anything unclaimed falls into Settings. Edit this to change the menu.
 */
const GROUPS: ReadonlyArray<{ key: string; label: string; icon: string; main: string; sections: string[]; keys?: string[] }> = [
  { key: "dashboard", label: "ops.nav.dashboard", icon: "layout-dashboard", main: "ops.dashboard", sections: ["insights"] },
  { key: "customers", label: "platform.nav.section_customers", icon: "users", main: "crm.persons", sections: ["customers"] },
  { key: "booking", label: "platform.nav.section_booking", icon: "calendar-days", main: "booking.bookings", sections: ["booking", "webinar"] },
  { key: "sales", label: "platform.nav.section_sales", icon: "shopping-cart", main: "commerce.products", sections: ["sales"] },
  { key: "finance", label: "platform.nav.section_finance", icon: "receipt", main: "finance.invoices", sections: ["finance"] },
  { key: "assistant", label: "assistant.nav.section", icon: "bot", main: "assistant.overview", sections: ["assistant"] },
  { key: "marketing", label: "platform.nav.section_marketing", icon: "megaphone", main: "email.overview", sections: ["email", "marketing"] },
  { key: "website", label: "platform.nav.section_website", icon: "globe", main: "site.website", sections: ["website"] },
  { key: "reports", label: "platform.nav.section_reports", icon: "chart-bar", main: "ops.reports", sections: ["reports"] },
  { key: "settings", label: "platform.nav.section_settings", icon: "settings", main: "platform.settings", sections: ["settings", "data", "system", "help"] },
];

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
  const entries = (NAV.admin as readonly AdminNavEntry[]).filter((e) => !e.permission || hasPermission(actor, e.permission as Permission) || (!!e.orPermission && hasPermission(actor, e.orPermission as Permission)));
  const flagged = await Promise.all(entries.map(async (e) => (!e.flag ? true : await flag(e.flag as FlagKey, actor).catch(() => false))));
  return entries.filter((_, i) => flagged[i]).sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
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
  const grouped = new Map<string, NavSection["items"]>(GROUPS.map((g) => [g.key, []]));
  entries.forEach((e, i) => {
    const n = badges[i];
    const label = soft(e.labelKey);
    const item = { key: e.key, href: e.href, label: n ? tr("platform.nav.with_badge", { label, count: n }) : label, icon: e.icon };
    const group = GROUPS.find((g) => g.keys?.includes(e.key)) ?? GROUPS.find((g) => g.sections.includes(e.section)) ?? GROUPS.at(-1)!;
    grouped.get(group.key)!.push(item);
  });
  const nav: NavSection[] = GROUPS.flatMap((g) => {
    const items = grouped.get(g.key)!;
    if (!items.length) return [];
    // The row opens the group's main entry, or its first entry when the actor cannot see the main one.
    const main = items.find((i) => i.key === g.main) ?? items[0]!;
    // Duplicate hrefs (one page listed by two modules) show once.
    const unique = items.filter((it, idx) => items.findIndex((o) => o.href === it.href) === idx);
    return [{ key: g.key, label: soft(g.label), href: main.href, icon: g.icon, items: unique }];
  });

  const secrets = await readMfaSecrets(db, actor.userId).catch(() => null);
  const codesLeft = secrets ? unusedCodeCount(secrets.codes) : null;
  const support = (await getSetting(db, "support")) as { emergency_phone: string };
  const pathname = ((await headers()).get("x-pathname") ?? "/admin").split("?")[0]!;
  const roleLabel = await getRoleLabel(db, actor.roleKey, locale).catch(() => soft(`platform.roles.${actor.roleKey}`));
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
  // With DEV_SKIP_MFA (local only) staff never use an authenticator, so recovery codes are moot.
  if (codesLeft !== null && codesLeft <= RECOVERY_CODES_LOW && !devSkipMfa()) {
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
      headerSlot={
        <AdminLocaleSwitch
          name={session.user.name ?? session.user.email}
          locale={locale}
          label={tr("platform.shell.language")}
          locales={LOCALES.map((l) => ({ value: l, short: URL_SEGMENT[l].toUpperCase(), label: tr(`platform.shell.locale_${URL_SEGMENT[l]}`) }))}
        />
      }
      logoSrc="/brand/beam-logo-header.png"
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
