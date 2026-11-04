"use client";
/**
 * The `/admin/system` overview tiles: last tick age, jobs by lane and status, oldest pending,
 * dead count (link), integration health, webhook volume, AI spend, files size, open incidents
 * and support, latest uptime (red below 99.5 %, PL-89a) and go-live progress. Refreshes the
 * route every 30 seconds.
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@beam/ui";
import { lab, type Labels } from "./settings-form";

export type SystemTilesData = {
  lastTickAt: string | null;
  jobStats: { lane: string; status: string; jobs: number }[];
  oldestPendingRunAt: string | null;
  dead: number;
  health: { provider: string; calls_24h: number; errors_24h: number; last_error_at: string | null }[];
  webhooks24h: number;
  aiSpendCents: number;
  aiBudgetCents: number;
  filesBytes: number;
  openIncidents: number;
  openSupport: number;
  latestUptimePct: number | null;
  gate: { confirmed: number; total: number };
  now: string;
};

export const UPTIME_TARGET_PCT = 99.5;

function ageMinutes(iso: string | null, now: string): number | null {
  return iso ? Math.max(0, Math.round((Date.parse(now) - Date.parse(iso)) / 60_000)) : null;
}

function Tile({ title, children, tone }: { title: string; children: React.ReactNode; tone?: "ok" | "warn" | "alert" }) {
  return (
    <Card data-tone={tone ?? "ok"} className={tone === "alert" ? "border-destructive" : tone === "warn" ? "border-warning" : undefined}>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-1 text-sm">{children}</CardContent>
    </Card>
  );
}

export function AutoRefresh({ seconds = 30 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}

export function SystemTiles({ data, labels, locale }: { data: SystemTilesData; labels: Labels; locale: string }) {
  const tick = ageMinutes(data.lastTickAt, data.now);
  const oldest = ageMinutes(data.oldestPendingRunAt, data.now);
  const money = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" });
  const mb = (b: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(b / 1024 ** 2);
  const lanes = ["fast", "bulk"];
  const statuses = ["pending", "running", "succeeded", "dead"];
  const count = (lane: string, status: string) => data.jobStats.find((s) => s.lane === lane && s.status === status)?.jobs ?? 0;
  const below = data.latestUptimePct !== null && data.latestUptimePct < UPTIME_TARGET_PCT;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <AutoRefresh />
      <Tile title={lab(labels, "tile_tick")} tone={tick === null || tick > 3 ? "alert" : "ok"}>
        <p className="text-2xl font-semibold">{tick === null ? lab(labels, "never") : lab(labels, "minutes_ago", { n: tick })}</p>
      </Tile>
      <Tile title={lab(labels, "tile_jobs")} tone={data.dead > 0 ? "warn" : "ok"}>
        <table className="text-xs">
          <thead>
            <tr>
              <th className="pr-2 text-left">{lab(labels, "lane")}</th>
              {statuses.map((s) => (
                <th key={s} className="pr-2 text-right">
                  {lab(labels, `status_${s}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lanes.map((l) => (
              <tr key={l}>
                <td className="pr-2">{lab(labels, `lane_${l}`)}</td>
                {statuses.map((s) => (
                  <td key={s} className="pr-2 text-right">
                    {count(l, s)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p>{lab(labels, "oldest_pending", { n: oldest ?? 0 })}</p>
        <a className="underline" href="/admin/system/jobs?status=dead">
          {lab(labels, "dead_jobs", { count: data.dead })}
        </a>
      </Tile>
      <Tile title={lab(labels, "tile_integrations")} tone={data.health.some((h) => h.errors_24h > 0) ? "warn" : "ok"}>
        {data.health.length === 0 ? <p>{lab(labels, "no_calls")}</p> : null}
        {data.health.map((h) => (
          <p key={h.provider} className="flex justify-between gap-2">
            <span>{h.provider}</span>
            <span>
              {h.calls_24h} / <span className={h.errors_24h > 0 ? "text-destructive" : undefined}>{lab(labels, "errors", { count: h.errors_24h })}</span>
            </span>
          </p>
        ))}
        <a className="underline" href="/admin/system/integrations">
          {lab(labels, "open_integrations")}
        </a>
      </Tile>
      <Tile title={lab(labels, "tile_webhooks")}>
        <p className="text-2xl font-semibold">{data.webhooks24h}</p>
        <a className="underline" href="/admin/system/webhooks">
          {lab(labels, "open_webhooks")}
        </a>
      </Tile>
      <Tile title={lab(labels, "tile_ai")} tone={data.aiSpendCents >= data.aiBudgetCents ? "alert" : data.aiSpendCents >= data.aiBudgetCents * 0.8 ? "warn" : "ok"}>
        <p className="text-2xl font-semibold">{money.format(data.aiSpendCents / 100)}</p>
        <p>{lab(labels, "of_budget", { budget: money.format(data.aiBudgetCents / 100) })}</p>
      </Tile>
      <Tile title={lab(labels, "tile_files")} tone={data.filesBytes > 5 * 1024 ** 3 ? "alert" : data.filesBytes > 4 * 1024 ** 3 ? "warn" : "ok"}>
        <p className="text-2xl font-semibold">{lab(labels, "megabytes", { n: mb(data.filesBytes) })}</p>
      </Tile>
      <Tile title={lab(labels, "tile_incidents")} tone={data.openIncidents > 0 ? "alert" : "ok"}>
        <p className="text-2xl font-semibold">{data.openIncidents}</p>
        <a className="underline" href="/admin/system/incidents">
          {lab(labels, "open_incidents")}
        </a>
      </Tile>
      <Tile title={lab(labels, "tile_support")} tone={data.openSupport > 0 ? "warn" : "ok"}>
        <p className="text-2xl font-semibold">{data.openSupport}</p>
        <a className="underline" href="/admin/system/support">
          {lab(labels, "open_support")}
        </a>
      </Tile>
      <Tile title={lab(labels, "tile_uptime")} tone={below ? "alert" : "ok"}>
        <p className={below ? "text-2xl font-semibold text-destructive" : "text-2xl font-semibold"}>
          {data.latestUptimePct === null ? "–" : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(data.latestUptimePct)} %`}
          {below ? ` (${lab(labels, "below_target")})` : ""}
        </p>
        <a className="underline" href="/admin/system/reports">
          {lab(labels, "open_reports")}
        </a>
      </Tile>
      <Tile title={lab(labels, "tile_gate")} tone={data.gate.confirmed === data.gate.total ? "ok" : "warn"}>
        <p className="text-2xl font-semibold">
          {data.gate.confirmed} / {data.gate.total}
        </p>
        <Badge variant={data.gate.confirmed === data.gate.total ? "success" : "warning"}>{lab(labels, data.gate.confirmed === data.gate.total ? "gate_complete" : "gate_open")}</Badge>
        <a className="underline" href="/admin/system/go-live">
          {lab(labels, "open_gate")}
        </a>
      </Tile>
    </div>
  );
}
