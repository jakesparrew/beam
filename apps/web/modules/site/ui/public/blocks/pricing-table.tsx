/**
 * `pricing_table` block (rules 25-26): prices from commerce only, VAT included, formatted per
 * locale; "Members: <amount>" when the product has a member price version or a member discount
 * and the block asks for it; a Buy link into commerce's guest checkout with the page's own path
 * as `from` (rule 31, D56). Inactive products were left out by `getPricingRows`.
 */
import { formatMoney } from "@beam/core/i18n";
import { checkoutPath } from "../../../server/urls";
import { secondaryButtonClass, type BlockContext, type BlockOf } from "../block-renderer";

export function PricingTableBlockView({ block, ctx }: { block: BlockOf<"pricing_table">; ctx: BlockContext }) {
  const rows = ctx.data.pricing[block.id] ?? [];
  if (!rows.length) return null;
  const { tr, locale } = ctx;
  return (
    <div className="space-y-6">
      {block.heading ? <h2 className="text-2xl font-semibold">{block.heading}</h2> : null}
      <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => (
          <li key={row.productId} data-product={row.sku} className="flex flex-col gap-2 rounded-xl border border-border p-6">
            <h3 className="text-lg font-semibold">{row.name}</h3>
            {row.creditUnits && (row.creditKind === "day" || row.creditKind === "night") ? (
              <p className="text-sm text-muted-foreground">{tr("site.blocks.pricing.sessions", { count: row.creditUnits })}</p>
            ) : null}
            {row.validityDays ? <p className="text-sm text-muted-foreground">{tr("site.blocks.pricing.validity", { days: row.validityDays })}</p> : null}
            <p className="text-2xl font-bold" data-price="public">
              {formatMoney(row.publicCents, locale)}
            </p>
            {block.showMemberPrice && row.memberCents !== null ? (
              <p className="text-sm font-medium" data-price="member">
                {tr("site.blocks.pricing.members", { amount: formatMoney(row.memberCents, locale) })}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">{tr("site.blocks.pricing.vatIncluded")}</p>
            <a href={checkoutPath(locale, row.sku, ctx.data.pagePath)} className={`${secondaryButtonClass} mt-auto`}>
              {tr("site.blocks.pricing.buy")}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
