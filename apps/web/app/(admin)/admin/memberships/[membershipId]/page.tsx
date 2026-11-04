import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { formatDate, formatDateTime, formatMoney } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, softTranslator, translator } from "@/lib/i18n";
import { creditsLabels, getMembership } from "@/modules/credits/queries";
import { MembershipActions, MembershipNotes } from "@/modules/credits/ui/membership-detail";
import { unitsText } from "@/modules/credits/ui/grants-table";

/** `/admin/memberships/[membershipId]` (`credits.read` or `memberships.write`), credits spec section 5. */
export default async function MembershipPage({ params }: { params: Promise<{ membershipId: string }> }) {
  const actor = await requireStaff();
  if (!hasPermission(actor, "credits.read") && !hasPermission(actor, "memberships.write")) notFound();
  const { membershipId } = await params;
  const locale = await adminLocale();
  const tr = translator(locale);
  const soft = softTranslator(locale);
  const t = (k: string, p?: Record<string, string | number>) => tr(`credits.admin.membership.${k}`, p);
  const d = await getMembership(await getAppDb(), membershipId).catch((e: unknown) => {
    if ((e as { code?: string }).code === "not_found") notFound();
    throw e;
  });
  const m = d.membership;
  const none = tr("credits.admin.common.none");
  const date = (x: Date | null) => (x ? formatDate(x, locale, "medium") : none);
  const eventLabel = (kind: string) => {
    const key = `credits.enum.membership_event.${kind.replace(/^membership\./, "")}`;
    const text = soft(key);
    return text === key ? kind : text;
  };
  const canWrite = hasPermission(actor, "memberships.write");
  const labels = canWrite ? creditsLabels(locale, ["admin.common", "admin.membership", "errors"]) : {};
  const facts: [string, string][] = [
    [t("plan"), d.planName[locale] ?? d.planName.en ?? ""],
    [t("member_since"), date(m.startedAt)],
    [t("current_period"), t("period_value", { start: date(m.currentPeriodStartAt), end: date(m.currentPeriodEndAt) })],
    [t("next_charge"), date(m.nextChargeAt)],
    [t("dunning"), String(m.dunningAttempt)],
    [t("discount"), t("discount_value", { pct: Number(m.discountPct) })],
    [t("mandate"), d.mandate ? tr(`credits.enum.mandate_status.${d.mandate.status}`) : t("mandate_none")],
  ];
  if (m.cancelAt) facts.push([t("cancel_at"), date(m.cancelAt)]);
  if (m.endedAt && m.endReason) facts.push([t("status"), t("ended", { date: date(m.endedAt), reason: tr(`credits.enum.end_reason.${m.endReason}`) })]);

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <Link href="/admin/memberships" className="text-sm text-muted-foreground hover:underline">
          {t("back")}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">
            <Link href={`/admin/persons/${m.personId}`} className="hover:underline">
              {d.personName || t("title")}
            </Link>
          </h1>
          <Badge variant={m.status === "active" ? "success" : m.status === "past_due" ? "destructive" : "secondary"}>{tr(`credits.enum.membership_status.${m.status}`)}</Badge>
        </div>
      </header>
      <Card>
        <CardContent className="pt-6">
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            {facts.map(([k, v]) => (
              <div key={k}>
                <dt className="text-sm text-muted-foreground">{k}</dt>
                <dd className="font-medium">{v}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
      {canWrite ? (
        <MembershipActions
          m={{
            membershipId: m.id,
            version: m.version,
            status: m.status,
            cancelAt: m.cancelAt?.toISOString() ?? null,
            periodEndText: date(m.currentPeriodEndAt),
            canRetry: m.status === "past_due" && !m.cancelAt && m.dunningAttempt < 3 && d.mandate?.status === "valid",
          }}
          labels={labels}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{t("read_only")}</p>
      )}
      <section className="grid gap-3">
        <h2 className="text-lg font-semibold">{t("included")}</h2>
        {d.currentGrants.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("included_empty")}</p>
        ) : (
          <ul className="grid gap-1 text-sm" aria-label={t("included_caption")}>
            {d.currentGrants.map((g) => (
              <li key={g.grantId} className="flex flex-wrap items-center gap-2">
                <Link href={`/admin/credits/grants/${g.grantId}`} className="font-medium hover:underline">
                  {tr(`credits.enum.kind.${g.kind}`)}
                </Link>
                <span className="tabular-nums">{tr("credits.admin.units.remaining_of", { remaining: unitsText(g.kind, g.remainingUnits, locale), base: g.baseUnits })}</span>
                <span className="text-muted-foreground">{date(g.expiresAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="grid gap-3">
        <h2 className="text-lg font-semibold">{t("periods")}</h2>
        <Table>
          <TableCaption>{t("periods")}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{t("col_start")}</TableHead>
              <TableHead>{t("col_end")}</TableHead>
              <TableHead>{t("col_source")}</TableHead>
              <TableHead className="text-right">{t("col_amount")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.periods.map((p) => (
              <TableRow key={p.id}>
                <TableCell>{date(p.periodStartAt)}</TableCell>
                <TableCell>{date(p.periodEndAt)}</TableCell>
                <TableCell>{tr(`credits.enum.period_source.${p.source}`)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(p.amountCents, locale)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
      <section className="grid gap-3">
        <h2 className="text-lg font-semibold">{t("orders")}</h2>
        {d.orders.length === 0 ? (
          <EmptyState title={t("orders_empty")} />
        ) : (
          <Table>
            <TableCaption>{t("orders")}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>{t("col_reference")}</TableHead>
                <TableHead>{t("col_order_status")}</TableHead>
                <TableHead className="text-right">{t("col_total")}</TableHead>
                <TableHead>{t("col_payments")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.orders.map((o) => (
                <TableRow key={o.orderId}>
                  <TableCell className="font-mono text-sm">{o.reference}</TableCell>
                  <TableCell>{soft(`commerce.order_status.${o.status}`)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(o.totalCents, locale)}</TableCell>
                  <TableCell>
                    <ul className="flex flex-wrap gap-1">
                      {o.payments.map((p, i) => (
                        <li key={i}>
                          <Badge variant="outline">
                            {formatDateTime(p.createdAt, locale, "short")} · {soft(`commerce.payment_status.${p.status}`)}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      <Card>
        <CardHeader>
          <CardTitle>{t("timeline")}</CardTitle>
        </CardHeader>
        <CardContent>
          {d.timeline.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("timeline_empty")}</p>
          ) : (
            <ol className="grid gap-1 text-sm">
              {d.timeline.map((e, i) => (
                <li key={i}>
                  <span className="text-muted-foreground">{formatDateTime(e.occurredAt, locale, "short")}</span> · {eventLabel(e.kind)}
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
      {canWrite ? (
        <section className="max-w-2xl">
          <MembershipNotes membershipId={m.id} version={m.version} notes={m.notes} labels={labels} />
        </section>
      ) : null}
    </div>
  );
}
