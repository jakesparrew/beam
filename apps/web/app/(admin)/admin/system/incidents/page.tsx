import Link from "next/link";
import { Badge, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { catalogueSection, listIncidents } from "@/modules/platform/queries";
import { IncidentForm } from "@/modules/platform/ui/incident-form";

const STATUSES = ["open", "contained", "resolved"] as const;

/** Hours between two instants, one decimal. */
const hours = (from: Date, to: Date) => Math.round(((to.getTime() - from.getTime()) / 3_600_000) * 10) / 10;

/**
 * `/admin/system/incidents` (`system.jobs`): the incident register (blueprint 65) with severity,
 * status and timers (time since discovery, BEAM notified, PL-73), and the form to record one.
 */
export default async function IncidentsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  await requireStaff({ permission: "system.jobs" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string, p?: Record<string, string | number>) => tr(`platform.incidents.${k}`, p);
  const status = (STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as (typeof STATUSES)[number]) : undefined;
  const rows = await listIncidents(await getAppDb(), status ? { status } : {});
  const now = new Date();
  const when = (d: Date | null) => (d ? d.toLocaleString(locale, { timeZone: "Europe/Brussels", dateStyle: "short", timeStyle: "short" }) : "–");

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("intro")}</p>
      </header>
      <nav aria-label={t("filter_status")} className="flex flex-wrap gap-3 text-sm">
        <Link href="/admin/system/incidents" className={status ? "underline" : "font-semibold"}>
          {t("all")}
        </Link>
        {STATUSES.map((s) => (
          <Link key={s} href={`/admin/system/incidents?status=${s}`} className={status === s ? "font-semibold" : "underline"}>
            {t(`status_${s}`)}
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <EmptyState title={t("empty")} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("field_title")}</TableHead>
              <TableHead>{t("field_severity")}</TableHead>
              <TableHead>{t("field_status")}</TableHead>
              <TableHead>{t("field_discovered_at")}</TableHead>
              <TableHead>{t("since_discovery")}</TableHead>
              <TableHead>{t("field_beam_notified_at")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const late = !r.beamNotifiedAt && hours(r.discoveredAt, now) >= 20;
              return (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link href={`/admin/system/incidents/${r.id}`} className="font-medium hover:underline">
                      {r.title}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={r.severity === "normal" ? "secondary" : "destructive"}>{t(`severity_${r.severity}`)}</Badge>
                  </TableCell>
                  <TableCell>{t(`status_${r.status}`)}</TableCell>
                  <TableCell>{when(r.discoveredAt)}</TableCell>
                  <TableCell>{t("hours", { n: hours(r.discoveredAt, r.resolvedAt ?? now) })}</TableCell>
                  <TableCell className={late ? "font-semibold text-destructive" : undefined}>{r.beamNotifiedAt ? when(r.beamNotifiedAt) : late ? t("notify_overdue") : t("not_yet")}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <section className="grid gap-3" aria-labelledby="new-incident">
        <h2 id="new-incident" className="text-lg font-medium">
          {t("new_title")}
        </h2>
        <IncidentForm labels={catalogueSection(locale, "platform.incidents")} errors={catalogueSection(locale, "platform.errors")} />
      </section>
    </div>
  );
}
