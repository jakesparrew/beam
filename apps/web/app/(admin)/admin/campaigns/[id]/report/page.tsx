import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Button } from "@beam/ui";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { catalogueSection, getCampaignReport } from "@/modules/email/queries";
import { CampaignReport } from "@/modules/email/ui/CampaignReport";

/**
 * `/admin/campaigns/[id]/report` (`email.write` or `reports.read`), email spec rule 61 and
 * section 5: `v_campaign_stats` tiles and rates (the frozen snapshot after 30 days, rule 62),
 * sends per 15 minutes, clicks per link, the per-locale table, bounces and complaints; Export CSV
 * (`reports.read`). "No data yet, sending starts at <time>" before the first send.
 */
export default async function CampaignReportPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireStaff();
  const canWrite = hasPermission(actor, "email.write");
  const canReports = hasPermission(actor, "reports.read");
  if (!canWrite && !canReports) notFound();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await getAppDb();
  const report = await getCampaignReport(db, id, { unmasked: hasPermission(actor, "persons.read") });
  if (!report) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const labels = catalogueSection(locale, "email.report");
  const status = catalogueSection(locale, "email.campaigns")[`status_${report.campaign.status}`] ?? report.campaign.status;
  const localeNames = { "nl-BE": tr("email.editor.locale_nl"), "fr-BE": tr("email.editor.locale_fr"), en: tr("email.editor.locale_en") };

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{(labels.title ?? "{name}").replace("{name}", report.campaign.name)}</h1>
          <div>
            <Badge variant={report.campaign.status === "sent" ? "default" : "secondary"} data-testid="report-campaign-status">
              {status}
            </Badge>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <Link href={`/admin/campaigns/${report.campaign.id}/recipients`}>{labels.recipients_link ?? "recipients_link"}</Link>
          </Button>
          <Button variant="ghost" asChild>
            <Link href={`/admin/campaigns/${report.campaign.id}`}>{labels.back ?? "back"}</Link>
          </Button>
        </div>
      </div>
      <CampaignReport report={report} locale={locale} labels={labels} localeNames={localeNames} canExport={canReports} />
    </div>
  );
}
