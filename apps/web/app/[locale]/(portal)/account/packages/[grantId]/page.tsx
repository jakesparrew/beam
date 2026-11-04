import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { formatDate, localeFromSegment, URL_SEGMENT } from "@beam/core/i18n";
import { requireCustomer } from "@/lib/auth";
import { getAppDb, NotFoundError } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { getMyPackage } from "@/modules/credits/queries";
import { grantTitle, PackageStatusBadge, UnitsProgress, unitsOfText, unitsText } from "@/modules/credits/ui/package-card";
import { StoreCreditOrders, UsageHistory } from "@/modules/credits/ui/usage-history";

/**
 * `/[locale]/account/packages/[grantId]` (credits spec section 5, rules 37 and 38): the usage
 * history of one package of the customer (or one shared with them): date, session, who used it
 * and the attendance; returned, expired, "Adjusted by BEAM" and "Extended by BEAM until …"
 * lines; the guest uses left this month; for store credit the orders it paid. A package of
 * someone else is the standard 404.
 */
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = localeFromSegment((await params).locale);
  if (!locale) return {};
  return { title: translator(locale)("credits.portal.package.title"), robots: { index: false, follow: false } };
}

export default async function AccountPackagePage({ params }: { params: Promise<{ locale: string; grantId: string }> }) {
  const { locale: segment, grantId } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  const tr = translator(locale);
  const seg = URL_SEGMENT[locale];
  const detail = await getMyPackage(await getAppDb(), actor.personId, grantId).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const p = detail.package;
  const title = grantTitle(p, locale, tr);
  const open = p.status === "active";

  return (
    <article aria-labelledby="package-title" className="grid max-w-4xl gap-6">
      <a href={`/${seg}/account/packages`} className="inline-flex min-h-11 w-fit items-center text-sm underline">
        {tr("credits.portal.package.back")}
      </a>
      <header className="grid gap-2">
        <h1 id="package-title" className="flex flex-wrap items-center gap-2 text-2xl font-semibold">
          <span>{title}</span>
          <PackageStatusBadge status={p.status} locale={locale} />
        </h1>
        {detail.ownerName ? <p className="text-sm">{tr("credits.portal.packages.shared_by", { name: detail.ownerName })}</p> : null}
        <p className="text-lg font-semibold">{unitsText(p.kind, p.remainingUnits, locale, tr)}</p>
        <p className="text-sm text-muted-foreground">
          {detail.upcoming
            ? tr("credits.units.starts_on", { date: formatDate(p.startsAt, locale) })
            : p.expiresAt
              ? tr("credits.units.expires_on", { date: formatDate(p.expiresAt, locale) })
              : tr("credits.units.no_expiry")}
        </p>
        {open ? (
          <UnitsProgress
            label={tr("credits.portal.packages.progress", { name: title })}
            remaining={p.remainingUnits}
            total={p.baseUnits}
            valueText={unitsOfText(p.kind, p.remainingUnits, p.baseUnits, locale, tr)}
          />
        ) : null}
        {detail.guestUsesLeft != null && open ? <p className="text-sm">{tr("credits.portal.package.guest_uses_left", { count: detail.guestUsesLeft })}</p> : null}
      </header>
      <section aria-labelledby="usage-title" className="grid gap-2">
        <h2 id="usage-title" className="text-lg font-semibold">
          {tr("credits.portal.package.title")}
        </h2>
        <UsageHistory detail={detail} locale={locale} />
      </section>
      <StoreCreditOrders detail={detail} locale={locale} />
    </article>
  );
}
