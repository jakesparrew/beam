import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@beam/ui";
import { brusselsDateKey } from "@beam/core/credits";
import { formatDate, formatMoney } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { creditsLabels, getGrant } from "@/modules/credits/queries";
import { AdjustDialog, GrantNoteForm } from "@/modules/credits/ui/adjust-dialog";
import { ExtendDialog } from "@/modules/credits/ui/extend-dialog";
import { GrantLedger } from "@/modules/credits/ui/grant-ledger";
import { grantName, statusVariant } from "@/modules/credits/ui/grants-table";
import { GuestHistory } from "@/modules/credits/ui/guest-history";
import { RevokeDialog } from "@/modules/credits/ui/revoke-dialog";
import { TransferDialog } from "@/modules/credits/ui/transfer-dialog";

/** `/admin/credits/grants/[grantId]` (`credits.read`; the actions need `credits.adjust`), credits spec section 5. */
export default async function GrantPage({ params }: { params: Promise<{ grantId: string }> }) {
  const actor = await requireStaff({ permission: "credits.read" });
  const { grantId } = await params;
  const locale = await adminLocale();
  const tr = translator(locale);
  const g = (k: string, p?: Record<string, string | number>) => tr(`credits.admin.grant.${k}`, p);
  const detail = await getGrant(await getAppDb(), grantId).catch((e: unknown) => {
    if ((e as { code?: string }).code === "not_found") notFound();
    throw e;
  });
  const { grant, balance } = detail;
  const isEuro = grant.creditKind === "euro";
  const amount = (n: number) => (isEuro ? formatMoney(n, locale) : String(n));
  const none = tr("credits.admin.common.none");
  const canAdjust = hasPermission(actor, "credits.adjust");
  const labels = canAdjust ? creditsLabels(locale, ["admin.common", "admin.grant", "admin.adjust", "admin.extend", "admin.revoke", "admin.transfer", "admin.person_picker", "errors"]) : {};
  const title = grantName({ productName: detail.productName, label: grant.label, source: grant.source }, locale, g("title"));
  const facts: [string, ReactNode][] = [
    [g("owner"), <Link key="o" href={`/admin/persons/${grant.personId}`} className="hover:underline">{detail.personName || none}</Link>],
    [g("kind"), tr(`credits.enum.kind.${grant.creditKind}`)],
    [g("source"), tr(`credits.enum.source.${grant.source}`)],
    [g("balance"), tr("credits.admin.units.remaining_of", { remaining: amount(balance.remainingUnits), base: amount(balance.baseUnits) })],
    [g("starts"), formatDate(grant.startsAt, locale, "medium")],
    [g("expires"), grant.expiresAt ? formatDate(grant.expiresAt, locale, "medium") : tr("credits.admin.common.no_expiry")],
    [g("vat_treatment"), tr(`credits.enum.vat_treatment.${grant.vatTreatment}`)],
    [g("vat_rate"), grant.vatRatePct === null ? none : g("vat_rate_value", { rate: Number(grant.vatRatePct) })],
    [g("unit_value"), formatMoney(grant.unitValueCents, locale)],
    [g("sharing"), g("sharing_value", { mode: tr(`credits.enum.sharing_mode.${grant.sharing.mode}`), count: grant.sharing.max_guest_uses_per_month })],
  ];
  if (detail.voucherLast4) facts.push([tr("credits.enum.source.voucher"), g("voucher_code", { last4: detail.voucherLast4 })]);

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <Link href="/admin/credits" className="text-sm text-muted-foreground hover:underline">
          {g("back")}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{title}</h1>
          <Badge variant={statusVariant(grant.status)}>{tr(`credits.enum.grant_status.${grant.status}`)}</Badge>
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
          <p className="mt-4 text-sm text-muted-foreground">{g("guest_uses_month", { count: detail.guestUsesThisMonth })}</p>
        </CardContent>
      </Card>
      {canAdjust ? (
        <section aria-label={g("actions")} className="flex flex-wrap gap-2">
          {grant.status === "active" || grant.status === "exhausted" ? <AdjustDialog grantId={grant.id} isEuro={isEuro} labels={labels} /> : null}
          {grant.status !== "revoked" && grant.expiresAt ? (
            <ExtendDialog grantId={grant.id} currentExpiresOn={brusselsDateKey(grant.expiresAt)} labels={labels} />
          ) : null}
          {grant.status === "active" && balance.remainingUnits > 0 ? (
            <>
              <TransferDialog grantId={grant.id} ownerPersonId={grant.personId} maxUnits={balance.remainingUnits} labels={labels} />
              <RevokeDialog grantId={grant.id} description={tr("credits.admin.revoke.description", { count: amount(balance.remainingUnits) })} labels={labels} />
            </>
          ) : null}
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">{g("read_only")}</p>
      )}
      <section className="grid gap-3">
        <h2 className="text-lg font-semibold">{g("ledger")}</h2>
        <GrantLedger entries={detail.entries} kind={grant.creditKind} ownerPersonId={grant.personId} locale={locale} />
      </section>
      {!isEuro ? (
        <section className="grid gap-3">
          <h2 className="text-lg font-semibold">{g("guests")}</h2>
          <GuestHistory guests={detail.guests} locale={locale} />
        </section>
      ) : null}
      {detail.shares.length ? (
        <Card>
          <CardHeader>
            <CardTitle>{g("shares")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-1 text-sm">
              {detail.shares.map((s) => (
                <li key={s.shareId} className="flex flex-wrap gap-2">
                  <Link href={`/admin/persons/${s.personId}`} className="hover:underline">
                    {s.name || none}
                  </Link>
                  {s.maxUnits ? <span>{g("share_max", { count: s.maxUnits })}</span> : null}
                  <Badge variant="outline">{tr(`credits.enum.grant_status.${s.status}`)}</Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
      {canAdjust ? (
        <section className="grid max-w-2xl gap-3">
          <GrantNoteForm grantId={grant.id} note={grant.note} labels={labels} />
        </section>
      ) : grant.note ? (
        <section className="grid gap-1">
          <h2 className="text-sm font-medium">{g("note")}</h2>
          <p className="whitespace-pre-wrap text-sm">{grant.note}</p>
        </section>
      ) : null}
    </div>
  );
}
