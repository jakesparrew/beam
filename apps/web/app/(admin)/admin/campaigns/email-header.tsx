import Link from "next/link";
import type { CampaignStatus } from "@beam/core/email";
import { PageHeader, Segmented, type Tone } from "@/modules/platform/ui/admin-kit";

/** The pill colour of a campaign status, on the list and the campaign header. */
export const CAMPAIGN_TONE: Record<CampaignStatus, Tone> = { draft: "muted", planning: "gold", scheduled: "info", sending: "warn", paused: "warn", sent: "ok", stopped: "bad", cancelled: "muted" };

export type EmailTab = "campaigns" | "stats" | "messages";

/**
 * The one header of the email area (owner review, November 2026): Nieuwsbrieven with "New
 * campaign" (`email.write`) and the tabs Nieuwsbrieven | Statistieken | Verzonden berichten, so
 * `/admin/email` and `/admin/email/messages` read as tabs of the newsletters page. The message
 * log needs `email.write`.
 */
export function EmailHeader({ active, canWrite, tr }: { active: EmailTab; canWrite: boolean; tr: (key: string) => string }) {
  const tabs: { key: EmailTab; href: "/admin/campaigns" | "/admin/email" | "/admin/email/messages"; label: string }[] = [
    { key: "campaigns", href: "/admin/campaigns", label: tr("email.campaigns.tab_list") },
    { key: "stats", href: "/admin/email", label: tr("email.campaigns.tab_stats") },
    ...(canWrite ? [{ key: "messages" as const, href: "/admin/email/messages" as const, label: tr("email.campaigns.tab_messages") }] : []),
  ];
  return (
    <>
      <PageHeader
        title={tr("email.nav.campaigns")}
        actions={
          canWrite ? (
            <Link href="/admin/campaigns/new" data-testid="campaign-new" className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[0.8125rem] font-semibold text-primary-foreground hover:opacity-90">
              + {tr("email.campaigns.new")}
            </Link>
          ) : null
        }
      />
      <Segmented label={tr("email.campaigns.tabs")} items={tabs.map((t) => ({ key: t.key, label: t.label, href: t.href, active: t.key === active }))} />
    </>
  );
}
