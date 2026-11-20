/**
 * `booking_cta` block (rule 31): day and night booking in the portal, one event session's
 * booking page, commerce's guest checkout for a product (`?sku=<sku>&from=<page path>`, D56) and
 * the gift-voucher page. A product that is no longer active hides the button.
 */
import type { Locale } from "@beam/core/i18n";
import type { BookingCtaTargetValue } from "@beam/core/site";
import { bookSessionPath, checkoutPath, giftPath, portalUrl } from "../../../server/urls";
import { ArrowBadge, goldButtonClass, type BlockContext, type BlockOf } from "../block-renderer";

/** A small line icon per booking target (decorative). */
function TargetIcon({ kind }: { kind: BookingCtaTargetValue["kind"] }) {
  const paths: Record<BookingCtaTargetValue["kind"], string> = {
    book_day: "M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
    book_night: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z",
    session: "M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
    buy_product: "M6 7h12l-1 13H7L6 7zM9 7a3 3 0 0 1 6 0",
    gift: "M4 11h16v9H4zM3 7h18v4H3zM12 7v13M12 7c-1.5-3-5-3-5-1s3 1 5 1zm0 0c1.5-3 5-3 5-1s-3 1-5 1z",
  };
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[kind]} />
    </svg>
  );
}

/** Two or more consecutive `booking_cta` blocks: a row of quick-action tiles. */
export function BookingCtaGroupView({ blocks, ctx }: { blocks: BlockOf<"booking_cta">[]; ctx: BlockContext }) {
  const items = blocks
    .map((block) => ({ block, href: bookingCtaHref(block.target, ctx.locale, ctx.data.pagePath, ctx.data.skus) }))
    .filter((x): x is { block: BlockOf<"booking_cta">; href: string } => !!x.href);
  if (!items.length) return null;
  return (
    <ul className={`grid gap-3 sm:grid-cols-2 ${items.length >= 4 ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
      {items.map(({ block, href }) => {
        const night = block.target.kind === "book_night";
        const tone = night
          ? "site-on-dark bg-[#212842] text-[#fffaef] border-[#2b3354]"
          : block.target.kind === "gift"
            ? "bg-[#f4ead3] border-[#eadfc6]"
            : "bg-card border-border";
        return (
          <li key={block.id}>
            <a
              href={href}
              data-target={block.target.kind}
              className={`group relative flex h-full items-center gap-4 overflow-hidden rounded-[1.75rem] border p-5 shadow-[0_18px_40px_-24px_rgba(33,40,66,0.55)] transition duration-300 hover:-translate-y-1 hover:shadow-[0_24px_48px_-20px_rgba(33,40,66,0.6)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${tone}`}
            >
              {night ? <span aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(1px_1px_at_20%_30%,#fffaef,transparent),radial-gradient(1px_1px_at_70%_20%,#d1a64a,transparent),radial-gradient(1.5px_1.5px_at_85%_70%,#fffaef,transparent),radial-gradient(1px_1px_at_40%_80%,#fffaef,transparent)] opacity-70" /> : null}
              <span className="site-gold relative inline-flex size-14 shrink-0 items-center justify-center rounded-2xl text-[#212842]">
                <TargetIcon kind={block.target.kind} />
              </span>
              <span className="relative min-w-0 flex-1">
                <span className="block text-base leading-snug font-semibold">{block.label}</span>
                {block.note ? <span className="mt-0.5 block text-sm text-muted-foreground">{block.note}</span> : null}
              </span>
              <span className="relative">
                <ArrowBadge dark={!night} />
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

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
      <a href={href} className={`${goldButtonClass} py-2 pr-2 pl-6 text-base`} data-target={block.target.kind}>
        {block.label}
        <ArrowBadge dark />
      </a>
    </div>
  );
}
