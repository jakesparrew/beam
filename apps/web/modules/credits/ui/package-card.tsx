/**
 * `PackageCard` (credits spec section 5, `/[locale]/account/packages`): one package of the customer
 * with its product name, the remaining units in words (rule 36: never "credits"), the expiry or
 * start date and a progress bar that carries the same words (`role="progressbar"` with
 * `aria-valuetext`). Status is a badge with text and a glyph, never colour only. Server component:
 * every string comes from the catalogue through `translator(locale)`.
 */
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@beam/ui";
import { formatDate, formatMoney, type Locale, type LocalizedText } from "@beam/core/i18n";
import type { CreditKind } from "@beam/core/credits";
import { translator } from "@/lib/i18n";
import type { MyPackage } from "../queries";

type Tr = ReturnType<typeof translator>;

const text = (v: LocalizedText | null | undefined, locale: Locale): string | null => {
  const s = v?.[locale];
  return typeof s === "string" && s.trim() ? s : null;
};

/** The package's name: product name, else the grant label, else the catalogue label of its source or kind. */
export function grantTitle(p: Pick<MyPackage, "productName" | "label" | "source" | "kind">, locale: Locale, tr: Tr = translator(locale)): string {
  const named = text(p.productName, locale) ?? text(p.label, locale);
  if (named) return named;
  if (p.source === "voucher") return tr("credits.labels.voucher");
  if (p.source === "import") return tr("credits.labels.import");
  if (p.source === "referral") return tr("credits.labels.referral_reward");
  if (p.source === "membership") return tr("credits.labels.membership");
  return tr(`credits.labels.${p.kind}`);
}

/** "4 sessions remaining", "1 night remaining", "€ 35,00 remaining" (rule 36). */
export function unitsText(kind: CreditKind, remaining: number, locale: Locale, tr: Tr = translator(locale)): string {
  if (kind === "euro") return tr("credits.units.euro", { amount: formatMoney(remaining, locale) });
  return tr(`credits.units.${kind}`, { count: remaining });
}

/** "4 of 10 sessions remaining" (the progress bar's words). */
export function unitsOfText(kind: CreditKind, remaining: number, total: number, locale: Locale, tr: Tr = translator(locale)): string {
  if (kind === "euro") return tr("credits.units.euro", { amount: formatMoney(remaining, locale) });
  return tr(`credits.units.${kind}_of`, { remaining, total });
}

/** A progress bar of the remaining units with the words as its value text. */
export function UnitsProgress({ label, remaining, total, valueText }: { label: string; remaining: number; total: number; valueText: string }) {
  const max = Math.max(total, 1);
  const pct = Math.max(0, Math.min(100, Math.round((remaining / max) * 100)));
  return (
    <div className="grid gap-1">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.max(0, Math.min(remaining, max))}
        aria-valuetext={valueText}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-sm text-muted-foreground">{valueText}</p>
    </div>
  );
}

const STATUS_GLYPH: Record<string, string> = { active: "●", exhausted: "✓", expired: "◷", revoked: "✕" };

export function PackageStatusBadge({ status, locale }: { status: MyPackage["status"]; locale: Locale }) {
  const tr = translator(locale);
  return (
    <Badge variant={status === "active" ? "success" : "outline"}>
      <span aria-hidden="true">{STATUS_GLYPH[status] ?? "●"}</span>
      {tr(`credits.enum.grant_status.${status}`)}
    </Badge>
  );
}

export type PackageCardProps = {
  pkg: MyPackage;
  locale: Locale;
  /** The usage page (`/[seg]/account/packages/<id>`); omitted for a card without a link. */
  href?: string;
  /** "Shared by Anna D." for a package shared with the reader. */
  sharedBy?: string | null;
  /** What the reader may still use of a shared package. */
  unitsForMe?: number | null;
  /** Upcoming packages show their start date instead of the progress bar. */
  upcoming?: boolean;
  /** Closed packages show their status badge. */
  closed?: boolean;
};

export function PackageCard({ pkg, locale, href, sharedBy, unitsForMe, upcoming, closed }: PackageCardProps) {
  const tr = translator(locale);
  const title = grantTitle(pkg, locale, tr);
  const words = unitsOfText(pkg.kind, pkg.remainingUnits, pkg.baseUnits, locale, tr);
  return (
    <Card data-testid="package-card" data-grant-id={pkg.grantId}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <span>{title}</span>
          {closed ? <PackageStatusBadge status={pkg.status} locale={locale} /> : null}
        </CardTitle>
        <CardDescription>
          {upcoming
            ? tr("credits.units.starts_on", { date: formatDate(pkg.startsAt, locale) })
            : pkg.expiresAt
              ? tr("credits.units.expires_on", { date: formatDate(pkg.expiresAt, locale) })
              : tr("credits.units.no_expiry")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-lg font-semibold">{unitsText(pkg.kind, pkg.remainingUnits, locale, tr)}</p>
        {!upcoming && !closed ? <UnitsProgress label={tr("credits.portal.packages.progress", { name: title })} remaining={pkg.remainingUnits} total={pkg.baseUnits} valueText={words} /> : null}
        {sharedBy ? <p className="text-sm">{tr("credits.portal.packages.shared_by", { name: sharedBy })}</p> : null}
        {unitsForMe != null ? <p className="text-sm">{tr("credits.portal.packages.for_you", { count: unitsForMe })}</p> : null}
        {href ? (
          <a href={href} className="inline-flex min-h-11 items-center text-sm font-medium underline" aria-label={`${tr("credits.portal.packages.open")}: ${title}`}>
            {tr("credits.portal.packages.open")}
          </a>
        ) : null}
      </CardContent>
    </Card>
  );
}
