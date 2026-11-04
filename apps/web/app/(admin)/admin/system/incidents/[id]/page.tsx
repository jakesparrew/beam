import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { catalogueSection, getIncident } from "@/modules/platform/queries";
import { IncidentForm } from "@/modules/platform/ui/incident-form";

/**
 * `/admin/system/incidents/[id]` (`system.jobs`): the seven blueprint-65 fields, severity, status
 * transitions (PL-73a) and the timers; `beam_notified_at` is never cleared once set.
 */
export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff({ permission: "system.jobs" });
  const { id } = await params;
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string, p?: Record<string, string | number>) => tr(`platform.incidents.${k}`, p);
  const incident = await getIncident(await getAppDb(), id);
  if (!incident) notFound();
  const end = incident.resolvedAt ?? new Date();
  const sinceDiscovery = Math.round(((end.getTime() - incident.discoveredAt.getTime()) / 3_600_000) * 10) / 10;
  const notifiedAfter = incident.beamNotifiedAt ? Math.round(((incident.beamNotifiedAt.getTime() - incident.discoveredAt.getTime()) / 3_600_000) * 10) / 10 : null;

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <Link href="/admin/system/incidents" className="text-sm text-muted-foreground hover:underline">
          {t("back")}
        </Link>
        <h1 className="text-2xl font-semibold">{incident.title}</h1>
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant={incident.severity === "normal" ? "secondary" : "destructive"}>{t(`severity_${incident.severity}`)}</Badge>
          <Badge variant="outline">{t(`status_${incident.status}`)}</Badge>
          <span>{t("timer_discovery", { n: sinceDiscovery })}</span>
          <span className={notifiedAfter === null && sinceDiscovery >= 20 ? "font-semibold text-destructive" : undefined}>
            {notifiedAfter === null ? t("timer_not_notified") : t("timer_notified", { n: notifiedAfter })}
          </span>
        </p>
      </header>
      <IncidentForm
        incident={{
          id: incident.id,
          title: incident.title,
          severity: incident.severity,
          status: incident.status,
          discoveredAt: incident.discoveredAt.toISOString(),
          beamNotifiedAt: incident.beamNotifiedAt ? incident.beamNotifiedAt.toISOString() : null,
          systemsAffected: incident.systemsAffected,
          dataAffected: incident.dataAffected,
          risk: incident.risk,
          actions: incident.actions,
          notifications: incident.notifications,
          resolution: incident.resolution,
        }}
        labels={catalogueSection(locale, "platform.incidents")}
        errors={catalogueSection(locale, "platform.errors")}
      />
    </div>
  );
}
