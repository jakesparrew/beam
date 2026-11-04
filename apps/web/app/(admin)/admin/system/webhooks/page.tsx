import Link from "next/link";
import { Badge, DataTable, EmptyState } from "@beam/ui";
import { webhookEvents } from "@beam/db/schema";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listWebhookEvents, type WebhookProviderName } from "@/modules/platform/queries";

type Search = { provider?: string; from?: string; to?: string; cursor?: string };
type Row = Awaited<ReturnType<typeof listWebhookEvents>>["rows"][number];

const PROVIDERS = webhookEvents.provider.enumValues as readonly string[];
const day = (v: string | undefined, end = false) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(new Date(`${v}T00:00:00Z`).getTime() + (end ? 86_400_000 : 0)) : undefined);

/** `/admin/system/webhooks` (`system.jobs`): provider, external id, received, job status; replay on the detail page. */
export default async function WebhooksPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireStaff({ permission: "system.jobs" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string) => tr(`platform.webhooks.${k}`);
  const provider = PROVIDERS.includes(sp.provider ?? "") ? (sp.provider as WebhookProviderName) : undefined;
  const from = day(sp.from);
  const to = day(sp.to, true);
  const { rows, nextCursor } = await listWebhookEvents(await getAppDb(), { ...(provider ? { provider } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), cursor: sp.cursor ?? null });
  const when = (d: Date) => d.toLocaleString(locale, { timeZone: "Europe/Brussels", dateStyle: "short", timeStyle: "medium" });

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("intro")}</p>
      </header>
      <DataTable<Row>
        rows={rows}
        nextCursor={nextCursor}
        searchParams={sp}
        caption={t("title")}
        filters={[{ kind: "select", key: "provider", label: t("col_provider"), allLabel: t("all_providers"), options: PROVIDERS.map((p) => ({ value: p, label: p })) }]}
        labels={{ pagination: tr("platform.table.pagination"), previous: tr("platform.table.previous"), next: tr("platform.table.next"), applyFilters: tr("platform.table.apply"), filters: tr("platform.table.filters") }}
        emptyState={<EmptyState title={t("empty")} />}
        columns={[
          { key: "provider", header: t("col_provider"), cell: (r) => r.provider },
          {
            key: "external",
            header: t("col_external_id"),
            cell: (r) => (
              <Link href={`/admin/system/webhooks/${r.id}`} className="font-mono text-xs hover:underline">
                {r.externalEventId}
              </Link>
            ),
          },
          { key: "received", header: t("col_received"), cell: (r) => when(r.receivedAt) },
          { key: "job", header: t("col_job_status"), cell: (r) => (r.jobStatus ? <Badge variant={r.jobStatus === "dead" ? "destructive" : r.jobStatus === "succeeded" ? "success" : "secondary"}>{tr(`platform.jobs.status_${r.jobStatus}`)}</Badge> : "–") },
        ]}
      />
    </div>
  );
}
