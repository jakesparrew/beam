/**
 * `pricing_table` block (rules 25-26): prices from commerce only, VAT included, formatted per
 * locale; "Members: <amount>" when the product has a member price version or a member discount
 * and the block asks for it; a Buy link into commerce's guest checkout with the page's own path
 * as `from` (rule 31, D56). Inactive products were left out by `getPricingRows`.
 * Rendered as price cards: what you get, the price large, the price per session or night for
 * packages, and the buy pill.
 */
import { formatMoney } from "@beam/core/i18n";
import { checkoutPath } from "../../../server/urls";
import { ArrowBadge, buttonClass, sectionHeadingClass, type BlockContext, type BlockOf } from "../block-renderer";

/** Validity in months when it is a whole-ish number of months (548 days = 18 months). */
const monthsOf = (days: number) => (days >= 60 ? Math.round(days / 30.44) : null);

export function PricingTableBlockView({ block, ctx }: { block: BlockOf<"pricing_table">; ctx: BlockContext }) {
  const rows = ctx.data.pricing[block.id] ?? [];
  if (!rows.length) return null;
  const { tr, locale } = ctx;
  const cols = rows.length === 1 ? "sm:max-w-md" : rows.length === 2 || rows.length === 4 ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-2 lg:grid-cols-3";
  return (
    <div className="space-y-8">
      {block.heading ? <h2 className={sectionHeadingClass}>{block.heading}</h2> : null}
      <ul className={`grid gap-4 ${cols}`}>
        {rows.map((row) => {
          const isCredit = row.creditUnits && (row.creditKind === "day" || row.creditKind === "night");
          const night = row.creditKind === "night";
          const months = row.validityDays ? monthsOf(row.validityDays) : null;
          const perUnit = isCredit && row.creditUnits! > 1 ? Math.round(row.publicCents / row.creditUnits!) : null;
          return (
            <li key={row.productId} data-product={row.sku} className="flex flex-col rounded-[1.75rem] border border-border bg-card p-6 transition hover:border-[#d1a64a] hover:shadow-md">
              <h3 className="text-lg font-semibold">{row.name}</h3>
              {isCredit ? (
                <p className="mt-1 text-sm text-muted-foreground">
                  {tr(night ? "site.blocks.pricing.nights" : "site.blocks.pricing.sessions", { count: row.creditUnits! })}
                </p>
              ) : null}
              <p className="font-display mt-6 text-5xl leading-none" data-price="public">
                {formatMoney(row.publicCents, locale)}
              </p>
              {perUnit !== null ? (
                <p className="mt-2 text-sm font-medium text-[#a0621e]">
                  {tr(night ? "site.blocks.pricing.perNight" : "site.blocks.pricing.perSession", { amount: formatMoney(perUnit, locale) })}
                </p>
              ) : null}
              {block.showMemberPrice && row.memberCents !== null ? (
                <p className="mt-2 text-sm font-medium" data-price="member">
                  {tr("site.blocks.pricing.members", { amount: formatMoney(row.memberCents, locale) })}
                </p>
              ) : null}
              <ul className="mt-5 space-y-1.5 border-t border-border pt-4 text-sm text-muted-foreground">
                {row.validityDays ? (
                  <li>{months ? tr("site.blocks.pricing.validityMonths", { months }) : tr("site.blocks.pricing.validity", { days: row.validityDays })}</li>
                ) : null}
                <li>{tr("site.blocks.pricing.vatIncluded")}</li>
              </ul>
              <a href={checkoutPath(locale, row.sku, ctx.data.pagePath)} className={`${buttonClass} mt-6 justify-between py-2 pr-2 pl-5`}>
                {tr("site.blocks.pricing.buy")}
                <ArrowBadge />
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
