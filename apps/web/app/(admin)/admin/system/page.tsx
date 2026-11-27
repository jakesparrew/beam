import Link from "next/link";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getSetting } from "@/lib/settings";
import { catalogueSection, getSystemOverview } from "@/modules/platform/queries";
import { PageHeader } from "@/modules/platform/ui/admin-kit";
import { AutoRefresh, SystemTiles } from "@/modules/platform/ui/system-tiles";

export const dynamic = "force-dynamic";

/**
 * `/admin/system` (`system.jobs`): last tick age, jobs by lane and status, oldest pending, dead
 * count, integration health, webhook volume, AI spend, files size, open incidents and support,
 * last uptime and go-live progress. Refreshes every 30 seconds.
 */
export default async function SystemPage() {
  await requireStaff({ permission: "system.jobs" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string) => tr(`platform.system.${k}`);
  const db = await getAppDb();
  const [overview, ai] = await Promise.all([getSystemOverview(db), getSetting(db, "ai") as Promise<{ monthly_budget_cents: number }>]);
  const links = [
    { href: "/admin/system/jobs", label: tr("platform.nav.jobs") },
    { href: "/admin/system/webhooks", label: t("link_webhooks") },
    { href: "/admin/system/integrations", label: t("link_integrations") },
    { href: "/admin/system/audit", label: tr("platform.nav.audit") },
    { href: "/admin/system/incidents", label: tr("platform.nav.incidents") },
    { href: "/admin/system/support", label: tr("platform.nav.support_register") },
    { href: "/admin/system/security", label: tr("platform.nav.security") },
    { href: "/admin/system/go-live", label: tr("platform.nav.go_live") },
    { href: "/admin/system/reports", label: tr("platform.nav.reports") },
    { href: "/admin/system/ai", label: tr("platform.nav.ai") },
  ] as const;

  return (
    <div className="grid gap-4">
      <PageHeader title={tr("platform.nav.technical")} description={t("intro")} />
      <nav aria-label={t("pages")} className="flex flex-wrap gap-x-4 gap-y-1 rounded-xl border border-border bg-card px-5 py-2.5 text-[0.8125rem] font-medium">
        {links.map((l) => (
          <Link key={l.href} href={l.href} className="text-muted-foreground hover:text-foreground">
            {l.label}
          </Link>
        ))}
      </nav>
      <AutoRefresh seconds={30} />
      <SystemTiles
        data={{
          ...overview,
          jobStats: overview.jobStats.map((s) => ({ lane: s.lane, status: s.status, jobs: Number(s.jobs) })),
          health: overview.health.map((h) => ({ provider: h.provider, calls_24h: Number(h.calls_24h), errors_24h: Number(h.errors_24h), last_error_at: h.last_error_at })),
          aiBudgetCents: ai.monthly_budget_cents,
          now: new Date().toISOString(),
        }}
        labels={catalogueSection(locale, "platform.system")}
        locale={locale}
      />
    </div>
  );
}
