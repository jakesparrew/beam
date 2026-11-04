import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { integrationCalls } from "@beam/db/schema";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getIntegrationHealth, listIntegrationCalls, type IntegrationProviderName } from "@/modules/platform/queries";

const PROVIDERS = integrationCalls.provider.enumValues as readonly string[];

/** `/admin/system/integrations` (`system.jobs`): `v_integration_health` per provider and the last 200 calls. */
export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ provider?: string; ok?: string }> }) {
  await requireStaff({ permission: "system.jobs" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string, p?: Record<string, string | number>) => tr(`platform.integrations.${k}`, p);
  const db = await getAppDb();
  const provider = PROVIDERS.includes(sp.provider ?? "") ? (sp.provider as IntegrationProviderName) : undefined;
  const ok = sp.ok === "true" ? true : sp.ok === "false" ? false : undefined;
  const [health, calls] = await Promise.all([getIntegrationHealth(db), listIntegrationCalls(db, { ...(provider ? { provider } : {}), ...(ok !== undefined ? { ok } : {}), limit: 200 })]);
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
