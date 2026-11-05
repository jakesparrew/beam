import { notFound } from "next/navigation";
import { formatDate, formatMoney } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { creditsLabels, getReferralsOverview } from "@/modules/credits/queries";
import type { PartnerFigureRow } from "@/modules/credits/ui/partner-figures";
import { ReferralTabs, type AttributionView, type CodeView, type CommissionView } from "@/modules/credits/ui/referral-tabs";

/**
 * `/admin/referrals` (credits spec section 5, rules 60 to 63, R3; `referrals.manage` or
 * `reports.read`): tabs Codes, Attributions, Commissions and Partners (`v_partner_performance`
 * per company). Writes (new code, activate, attribute, reject, commission status) need
 * `referrals.manage`; `reports.read` alone reads.
 */
export default async function ReferralsPage() {
  const actor = await requireStaff();
  const canManage = hasPermission(actor, "referrals.manage");
  if (!canManage && !hasPermission(actor, "reports.read")) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const r = (k: string, p?: Record<string, string | number>) => tr(`credits.admin.referrals.${k}`, p);
  const none = tr("credits.admin.common.none");
  const date = (d: Date | null) => (d ? formatDate(d, locale) : none);
  const money = (c: number) => formatMoney(c, locale);
  const data = await getReferralsOverview(await getAppDb());

  const rewardText = (rw: { credit_kind: "day" | "night"; units: number; validity_days: number } | null, fallback: string) =>
    rw ? r("reward_value", { units: rw.units, kind: tr(`credits.enum.kind.${rw.credit_kind}`), days: rw.validity_days }) : fallback;

  const codes: CodeView[] = data.codes.map((c) => ({
    id: c.id,
    code: c.code,
    ownerText: c.companyName ?? c.personName ?? none,
    ownerPersonId: c.personId,
    usesText: c.maxUses != null ? r("uses_of", { uses: c.uses, max: c.maxUses }) : String(c.uses),
    rewardsText: [
      `${r("referrer_short")}: ${rewardText(c.referrerReward, c.personId ? r("reward_settings") : none)}`,
      `${r("referee_short")}: ${rewardText(c.refereeReward, c.personId ? r("reward_settings") : none)}`,
    ].join(" · "),
    isActive: c.isActive,
  }));
  const attributions: AttributionView[] = data.attributions.map((a) => ({
    id: a.id,
    status: a.status,
    referredName: a.referredName ?? a.referredPersonId.slice(0, 8),
    referredPersonId: a.referredPersonId,
    referrerText: [a.referrerName, a.companyName].filter(Boolean).join(" · ") || none,
    sourceText: `${tr(`credits.enum.attribution_source.${a.source}`)}${a.code ? ` (${a.code})` : ""}`,
    attributedText: date(a.attributedAt),
    firstPaidText: date(a.firstPaidAt),
    qualifiesText: date(a.qualifiesAt),
    rewardText:
      a.status === "rewarded"
        ? a.referrerRewardGrantId
          ? r("reward_granted")
          : r("reward_none")
        : a.status === "rejected"
          ? tr(`credits.admin.referrals.rejected_${["self_referral", "already_customer", "cap_reached"].includes(a.rejectedReason ?? "") ? a.rejectedReason : "staff"}`)
          : a.status === "qualified"
            ? r("reward_due", { date: date(a.qualifiesAt) })
            : none,
  }));
  const commissions: CommissionView[] = data.commissions.map((c) => ({
    id: c.id,
    status: c.status,
    monthText: new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${c.periodMonth}T00:00:00Z`)),
    partnerText: c.companyName ?? none,
    orderText: `${c.orderReference ?? c.orderId.slice(0, 8)}${c.refundId ? ` · ${r("refund")}` : ""}`,
    orderId: c.orderId,
    baseText: money(c.baseCents),
    pctText: `${Number(c.commissionPct).toLocaleString(locale)} %`,
    amountText: money(c.amountCents),
  }));
  const byCompany = new Map<string, PartnerFigureRow & { revenue: number; accrued: number; paid: number }>();
  for (const m of data.partners) {
    const row = byCompany.get(m.partnerCompanyId) ?? { key: m.partnerCompanyId, label: m.companyName ?? none, referred: 0, customers: 0, revenue: 0, accrued: 0, paid: 0, revenueText: "", accruedText: "", paidText: "" };
    row.referred += m.referredCount;
    row.customers += m.customersCount;
    row.revenue += m.revenueCents;
    row.accrued += m.commissionAccruedCents;
    row.paid += m.commissionPaidCents;
    byCompany.set(m.partnerCompanyId, row);
  }
  const partners: PartnerFigureRow[] = [...byCompany.values()].map(({ revenue, accrued, paid, ...row }) => ({
    ...row,
    revenueText: money(revenue),
    accruedText: money(accrued),
    paidText: money(paid),
  }));
  const labels = creditsLabels(locale, ["admin.common", "admin.referrals", "errors", "enum.kind", "enum.attribution_status", "enum.commission_status"]);

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">{r("title")}</h1>
        <p className="max-w-prose text-muted-foreground">{r("intro")}</p>
        {!canManage ? <p className="text-sm text-muted-foreground">{r("read_only")}</p> : null}
      </header>
      {codes.length === 0 && attributions.length === 0 && commissions.length === 0 && !canManage ? (
        <p className="text-muted-foreground">{r("empty")}</p>
      ) : (
        <ReferralTabs
          codes={codes}
          attributions={attributions}
          commissions={commissions}
          partners={partners}
          partnerOptions={data.partnerCompanies.map((p) => ({ id: p.id, name: p.name }))}
          canManage={canManage}
          labels={labels}
        />
      )}
    </div>
  );
}
