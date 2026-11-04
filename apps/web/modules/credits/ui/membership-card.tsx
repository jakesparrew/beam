/**
 * `MembershipCard` (credits spec section 5, `/[locale]/account/membership`): plan, status (text
 * badge with a glyph), member since, current period, next renewal with its amount, payment method,
 * this period's included sessions and nights with what remains, the member discount, the upcoming
 * plan and the customer's actions (cancel with the end date, resume, pay now, change plan). The
 * benefits list and the period history are separate components. Server component.
 */
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@beam/ui";
import { formatDate, formatMoney, type Locale } from "@beam/core/i18n";
import { translator } from "@/lib/i18n";
import { creditsLabels, type MembershipStatus, type MyMembership } from "../queries";
import { CancelMembershipDialog, PayRenewalButton, ResumeMembershipButton, type MembershipActionLabels } from "./cancel-membership-dialog";
import { UnitsProgress, unitsOfText, unitsText } from "./package-card";

type Tr = ReturnType<typeof translator>;

/** The client action labels: `membership.*` and `errors.*` of `credits.portal`. */
export function membershipActionLabels(locale: Locale): MembershipActionLabels {
  const raw = creditsLabels(locale, ["portal.membership", "portal.errors"]);
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.replace(/^portal\./, ""), v]));
}

const STATUS_GLYPH: Record<MembershipStatus, string> = { pending: "◷", active: "●", past_due: "!", cancelled: "✕", expired: "✕" };

export function MembershipStatusBadge({ status, locale }: { status: MembershipStatus; locale: Locale }) {
  const tr = translator(locale);
  const variant = status === "active" ? "success" : status === "past_due" ? "warning" : "outline";
  return (
    <Badge variant={variant} data-status={status}>
      <span aria-hidden="true">{STATUS_GLYPH[status]}</span>
      {tr(`credits.portal.membership.status.${status}`)}
    </Badge>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[12rem_1fr] sm:gap-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function paymentMethodText(m: MyMembership, tr: Tr): string {
  if (m.paymentMethod && m.paymentMethod.status === "valid") return tr("credits.portal.membership.payment_mandate", { method: m.paymentMethod.summary ?? m.paymentMethod.method });
  return tr("credits.portal.membership.payment_link");
}

/** The cancel dialog's sentence: the end date at period end for `active`, "today" otherwise (rule 53). */
export function cancelDescription(m: Pick<MyMembership, "status" | "currentPeriodEndAt">, locale: Locale, tr: Tr = translator(locale)): string {
  return m.status === "active"
    ? tr("credits.portal.membership.cancel_body_period_end", { date: formatDate(m.currentPeriodEndAt, locale) })
    : tr("credits.portal.membership.cancel_body_now");
}

export function MembershipCard({ membership: m, locale, shopHref }: { membership: MyMembership; locale: Locale; shopHref: string }) {
  const tr = translator(locale);
  const plan = m.planName?.[locale] ?? "";
  const labels = membershipActionLabels(locale);
  const live = m.status === "active" || m.status === "past_due";
  return (
    <Card data-testid="membership-card">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
          <span>{plan}</span>
          {live ? (
            <Badge variant="secondary" data-testid="member-badge">
              {tr("credits.portal.membership.member_badge")}
            </Badge>
          ) : null}
          <MembershipStatusBadge status={m.status} locale={locale} />
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5">
        {m.status === "past_due" && m.canPay ? (
          <p role="status" className="rounded-md border border-warning bg-warning/15 p-3 text-sm">
            {tr("credits.portal.membership.pay_due")}
          </p>
        ) : m.canPay ? (
          <p role="status" className="text-sm">
            {tr("credits.portal.membership.pay_link_due")}
          </p>
        ) : null}
        {m.cancelAt && m.status === "active" ? (
          <p role="status" className="text-sm font-medium" data-testid="membership-ends">
            {tr("credits.portal.membership.ends_on", { date: formatDate(m.cancelAt, locale) })}
          </p>
        ) : null}
        <dl className="grid gap-2">
          <Row label={tr("credits.portal.membership.member_since")}>{formatDate(m.memberSince, locale)}</Row>
          {m.status === "pending" ? (
            <Row label={tr("credits.portal.membership.status_label")}>{tr("credits.portal.membership.starts_on", { date: formatDate(m.currentPeriodStartAt, locale) })}</Row>
          ) : null}
          {live || m.status === "pending" ? (
            <Row label={tr("credits.portal.membership.current_period")}>
              {tr("credits.portal.membership.period_range", { from: formatDate(m.currentPeriodStartAt, locale), to: formatDate(m.currentPeriodEndAt, locale) })}
            </Row>
          ) : null}
          {m.nextRenewalAt ? (
            <Row label={tr("credits.portal.membership.next_renewal")}>
              {m.renewalAmountCents != null
                ? tr("credits.portal.membership.renewal_amount", { amount: formatMoney(m.renewalAmountCents, locale), date: formatDate(m.nextRenewalAt, locale) })
                : formatDate(m.nextRenewalAt, locale)}
            </Row>
          ) : null}
          {m.endedAt ? <Row label={tr("credits.portal.membership.status_label")}>{tr("credits.portal.membership.ended_on", { date: formatDate(m.endedAt, locale) })}</Row> : null}
          {live ? <Row label={tr("credits.portal.membership.payment_method")}>{paymentMethodText(m, tr)}</Row> : null}
          {m.discountPct > 0 ? (
            <Row label={tr("credits.portal.membership.discount")}>{tr("credits.portal.membership.discount_value", { pct: new Intl.NumberFormat(locale).format(m.discountPct) })}</Row>
          ) : null}
        </dl>
        {live ? (
          <section aria-labelledby="membership-included" className="grid gap-3">
            <h2 id="membership-included" className="text-base font-semibold">
              {tr("credits.portal.membership.included")}
            </h2>
            {m.included.length === 0 ? (
              <p className="text-sm text-muted-foreground">{tr("credits.portal.membership.included_none")}</p>
            ) : (
              m.included.map((g) => (
                <div key={g.grantId} className="grid gap-1">
                  <p className="text-sm font-medium">{unitsText(g.kind, g.remainingUnits, locale, tr)}</p>
                  <UnitsProgress
                    label={tr("credits.portal.packages.progress", { name: tr(`credits.labels.${g.kind}`) })}
                    remaining={g.remainingUnits}
                    total={g.baseUnits}
                    valueText={unitsOfText(g.kind, g.remainingUnits, g.baseUnits, locale, tr)}
                  />
                </div>
              ))
            )}
          </section>
        ) : null}
        {m.upcoming ? (
          <p className="text-sm">{tr("credits.portal.membership.upcoming", { plan: m.upcoming.planName?.[locale] ?? "", date: formatDate(m.upcoming.startsAt, locale) })}</p>
        ) : null}
        <div className="flex flex-wrap items-start gap-3">
          {m.canPay ? <PayRenewalButton membershipId={m.membershipId} labels={labels} /> : null}
          {m.canResume ? (
            <div className="grid gap-1">
              <p className="text-sm text-muted-foreground">{tr("credits.portal.membership.resume_hint")}</p>
              <ResumeMembershipButton membershipId={m.membershipId} version={m.version} labels={labels} />
            </div>
          ) : null}
          {m.canCancel ? <CancelMembershipDialog membershipId={m.membershipId} version={m.version} description={cancelDescription(m, locale, tr)} labels={labels} /> : null}
        </div>
        {m.status === "active" ? (
          <div className="grid gap-1">
            <a href={shopHref} className="inline-flex min-h-11 w-fit items-center text-sm font-medium underline">
              {tr("credits.portal.membership.change_plan")}
            </a>
            <p className="text-sm text-muted-foreground">{tr("credits.portal.membership.change_plan_hint", { date: formatDate(m.cancelAt ?? m.currentPeriodEndAt, locale) })}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The history of membership periods (`membership_periods`). */
export function MembershipPeriods({ membership: m, locale }: { membership: MyMembership; locale: Locale }) {
  const tr = translator(locale);
  if (m.periods.length === 0) return null;
  return (
    <section aria-labelledby="membership-history" className="grid gap-2">
      <h2 id="membership-history" className="text-lg font-semibold">
        {tr("credits.portal.membership.history")}
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">{tr("credits.portal.membership.history_caption")}</caption>
          <thead>
            <tr className="border-b text-left">
              <th scope="col" className="py-2 pr-3 font-medium">{tr("credits.portal.membership.col_period")}</th>
              <th scope="col" className="py-2 pr-3 font-medium">{tr("credits.portal.membership.col_source")}</th>
              <th scope="col" className="py-2 text-right font-medium">{tr("credits.portal.membership.col_amount")}</th>
            </tr>
          </thead>
          <tbody>
            {m.periods.map((p) => (
              <tr key={`${p.periodStartAt.toISOString()}:${p.source}`} className="border-b last:border-0">
                <td className="py-2 pr-3">{tr("credits.portal.membership.period_range", { from: formatDate(p.periodStartAt, locale), to: formatDate(p.periodEndAt, locale) })}</td>
                <td className="py-2 pr-3">{tr(`credits.portal.membership.source.${p.source}`)}</td>
                <td className="py-2 text-right tabular-nums">{p.amountCents != null ? formatMoney(p.amountCents, locale) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
