/**
 * `booking_cta` block (rule 31): day and night booking in the portal, one event session's
 * booking page, commerce's guest checkout for a product (`?sku=<sku>&from=<page path>`, D56) and
 * the gift-voucher page. A product that is no longer active hides the button.
 */
import type { Locale } from "@beam/core/i18n";
import type { BookingCtaTargetValue } from "@beam/core/site";
import { bookSessionPath, checkoutPath, giftPath, portalUrl } from "../../../server/urls";
import { buttonClass, type BlockContext, type BlockOf } from "../block-renderer";

export function bookingCtaHref(target: BookingCtaTargetValue, locale: Locale, pagePath: string, skus: Readonly<Record<string, string>>): string | null {
  switch (target.kind) {
    case "book_day":
      return portalUrl(locale, "book_day");
    case "book_night":
      return portalUrl(locale, "book_night");
    case "session":
      return bookSessionPath(locale, target.sessionId);
    case "buy_product": {
      const sku = skus[target.productId];
      return sku ? checkoutPath(locale, sku, pagePath) : null;
    }
    case "gift":
      return giftPath(locale);
  }
}

export function BookingCtaBlockView({ block, ctx }: { block: BlockOf<"booking_cta">; ctx: BlockContext }) {
  const href = bookingCtaHref(block.target, ctx.locale, ctx.data.pagePath, ctx.data.skus);
  if (!href) return null;
  return (
    <div className="flex justify-center">
      <a href={href} className={buttonClass} data-target={block.target.kind}>
        {block.label}
      </a>
    </div>
  );
}
