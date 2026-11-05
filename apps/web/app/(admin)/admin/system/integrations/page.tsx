import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { integrationCalls } from "@beam/db/schema";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getIntegrationHealth, getTokenIntegrationStatus, listIntegrationCalls, type IntegrationProviderName, type TokenIntegrationStatus } from "@/modules/platform/queries";

const PROVIDERS = integrationCalls.provider.enumValues as readonly string[];

type HealthRow = { provider: string; calls_24h: number; errors_24h: number; last_ok_at: string | null; last_error_at: string | null };

/**
 * `/admin/system/integrations` (`system.jobs`): `v_integration_health` per provider and the last
 * 200 calls. R3 (platform-P9): the token integrations (Meta and Google Ads, crm's Meta inbox)
 * always have a tile, with the token status (env names only, never values) and "data as of"
 * (the last successful pull or webhook, which may be older than the 24-hour window).
 */
export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ provider?: string; ok?: string }> }) {
  await requireStaff({ permission: "system.jobs" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string, p?: Record<string, string | number>) => tr(`platform.integrations.${k}`, p);
  const db = await getAppDb();
  const provider = PROVIDERS.includes(sp.provider ?? "") ? (sp.provider as IntegrationProviderName) : undefined;
  const ok = sp.ok === "true" ? true : sp.ok === "false" ? false : undefined;
  const [health24h, tokens, calls] = await Promise.all([
    getIntegrationHealth(db),
    getTokenIntegrationStatus(db),
    listIntegrationCalls(db, { ...(provider ? { provider } : {}), ...(ok !== undefined ? { ok } : {}), limit: 200 }),
  ]);
  const health: HealthRow[] = [
    ...health24h,
    ...tokens
      .filter((s) => !health24h.some((h) => h.provider === s.provider))
      .map((s) => ({ provider: s.provider, calls_24h: 0, errors_24h: 0, last_ok_at: null, last_error_at: null })),
  ].sort((a, b) => a.provider.localeCompare(b.provider));
  const tokenOf = (p: string) => tokens.find((s) => s.provider === p);
  const when = (d: Date | string | null) => (d ? new Date(d).toLocaleString(locale, { timeZone: "Europe/Brussels", dateStyle: "short", timeStyle: "medium" }) : "–");

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("intro")}</p>
      </header>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {health.map((h) => (
          <li key={h.provider}>
            <Card className={Number(h.errors_24h) > 0 ? "border-warning" : undefined}>
              <CardHeader>
                <CardTitle className="text-sm font-medium">{h.provider}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-1 text-sm">
                <p>{t("calls_24h", { count: Number(h.calls_24h) })}</p>
                <p className={Number(h.errors_24h) > 0 ? "text-destructive" : undefined}>{t("errors_24h", { count: Number(h.errors_24h) })}</p>
                <p className="text-xs text-muted-foreground">{t("last_ok", { when: when(h.last_ok_at) })}</p>
                <p className="text-xs text-muted-foreground">{t("last_error", { when: when(h.last_error_at) })}</p>
                <TokenStatus status={tokenOf(h.provider)} ok={t("token_ok")} missing={t("token_missing")} dataAsOf={(d) => t("data_as_of", { date: when(d) })} />
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      <form method="get" className="flex flex-wrap items-end gap-3" role="search" aria-label={tr("platform.table.filters")}>
        <label className="grid gap-1 text-sm">
          {t("col_provider")}
          <select name="provider" defaultValue={provider ?? ""} className="h-9 rounded-md border bg-background px-2">
            <option value="">{t("all_providers")}</option>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          {t("col_status")}
          <select name="ok" defaultValue={sp.ok ?? ""} className="h-9 rounded-md border bg-background px-2">
            <option value="">{t("all_statuses")}</option>
            <option value="true">{t("ok")}</option>
            <option value="false">{t("failed")}</option>
          </select>
        </label>
        <button type="submit" className="h-9 rounded-md border px-3 text-sm">
          {tr("platform.table.apply")}
        </button>
      </form>
      {calls.rows.length === 0 ? (
        <EmptyState title={t("empty")} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("col_when")}</TableHead>
              <TableHead>{t("col_provider")}</TableHead>
              <TableHead>{t("col_operation")}</TableHead>
              <TableHead>{t("col_status")}</TableHead>
              <TableHead>{t("col_duration")}</TableHead>
              <TableHead>{t("col_error")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {calls.rows.map((c) => (
              <TableRow key={c.id}>
                <TableCell>{when(c.createdAt)}</TableCell>
                <TableCell>{c.provider}</TableCell>
                <TableCell className="font-mono text-xs">{c.operation}</TableCell>
                <TableCell>
                  <Badge variant={c.ok ? "success" : "destructive"}>{c.statusCode ?? (c.ok ? t("ok") : t("failed"))}</Badge>
                </TableCell>
                <TableCell>{c.durationMs === null ? "–" : t("ms", { n: c.durationMs })}</TableCell>
                <TableCell className="max-w-80 truncate text-xs">{c.error?.split("\n")[0] ?? ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/** R3: the env names a token integration needs, each OK or missing, and the data date. */
function TokenStatus({ status, ok, missing, dataAsOf }: { status: TokenIntegrationStatus | undefined; ok: string; missing: string; dataAsOf: (d: Date | null) => string }) {
  if (!status) return null;
  return (
    <>
      <ul className="grid gap-1 text-xs">
        {status.tokens.map((k) => (
          <li key={k.name} className="flex items-center justify-between gap-2">
            <span className="font-mono">{k.name}</span>
            <Badge variant={k.configured ? "success" : "destructive"}>{k.configured ? ok : missing}</Badge>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{dataAsOf(status.dataAsOf)}</p>
    </>
  );
}
