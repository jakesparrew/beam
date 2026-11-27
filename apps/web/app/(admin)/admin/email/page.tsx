import { notFound } from "next/navigation";
import { EmptyState } from "@beam/ui";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { catalogueSection, getDeliverability } from "@/modules/email/queries";
import { DeliverabilityPanel } from "@/modules/email/ui/DeliverabilityPanel";
import { SecondaryAction } from "@/modules/platform/ui/admin-kit";
import { EmailHeader } from "../campaigns/email-header";

const fill = (text: string, params: Record<string, string | number> = {}) => text.replace(/\{(\w+)\}/g, (_, p: string) => String(params[p] ?? `{${p}}`));

/**
 * `/admin/email` (`email.write` or `reports.read`), email spec section 5, the Statistieken tab of
 * the newsletters page (owner review, November 2026): KPI tiles of the last
 * 30 days, domain status, warm-up week, today's cap and sent count, the complaint (rule 38) and
 * delivery (rule 38a) banners, blocked-translation messages and the last 20 suppressions.
 */
export default async function EmailOverviewPage() {
  const actor = await requireStaff();
  const canWrite = hasPermission(actor, "email.write");
  if (!canWrite && !hasPermission(actor, "reports.read")) notFound();
  const db = await getAppDb();
  const data = await getDeliverability(db);
  const locale = await adminLocale();
  const tr = translator(locale);
  const labels = catalogueSection(locale, "email.deliverability");
  const t = (key: string, params?: Record<string, string | number>) => fill(labels[key] ?? key, params);

  return (
    <div className="grid gap-4">
      <EmailHeader active="stats" canWrite={canWrite} tr={tr} />
      {data.hasAnyMessage ? (
        <DeliverabilityPanel data={data} locale={locale} t={t} />
      ) : (
        <EmptyState
          title={t("empty_title")}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <SecondaryAction href="/admin/templates">{t("empty_templates")}</SecondaryAction>
            </div>
          }
        />
      )}
    </div>
  );
}
