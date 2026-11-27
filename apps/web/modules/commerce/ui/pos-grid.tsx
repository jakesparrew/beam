/**
 * The POS product grid (commerce spec 5.1, rule 56): tabs (Sessions today, Food & drinks,
 * Packages, Memberships, Tickets, Vouchers, Items) over the `is_pos_visible` products, and today's
 * sessions with free seats. Every tile is a link that adds one to the basket kept in the URL (a
 * second tap adds another), so the grid works without JavaScript and by keyboard; a tile shows
 * how many are in the basket; tiles are at least 44 px high. Food & drinks (owner decision
 * November 2026: BEAM's till replaces Lightspeed) are item products of category food or drink.
 * A server component: it receives its texts already translated.
 */
import Link from "next/link";
import { formatDateTime, formatMoney, type Locale } from "@beam/core/i18n";

export const POS_TABS = ["sessions", "food", "package", "membership", "ticket", "voucher", "item"] as const;
export type PosTab = (typeof POS_TABS)[number];

export type PosGridProduct = { id: string; name: string; sku: string; priceCents: number | null; href: string; /** In the basket now. */ quantity?: number; /** A small tag (food or drink). */ tag?: string | null };
export type PosGridSession = { sessionId: string; title: string; startsAt: Date; free: number; priceCents: number | null; href: string | null };

export function PosGrid(props: {
  locale: Locale;
  active: PosTab;
  tabHref: (tab: PosTab) => string;
  products: PosGridProduct[];
  sessions: PosGridSession[];
  text: {
    tabsLabel: string;
    tab: (tab: PosTab) => string;
    add: (name: string) => string;
    seatsFree: (count: number) => string;
    noSessions: string;
    noProducts: string;
    noPrice: string;
    inBasket: (count: number) => string;
  };
}) {
  const { locale, active, text } = props;
  const money = (c: number | null) => (c === null ? text.noPrice : formatMoney(c, locale));
  const tile = "relative flex min-h-20 flex-col justify-between gap-1 rounded-xl border border-border bg-card p-3 text-left text-[0.8125rem] hover:border-foreground/30 hover:bg-[#faf9f6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <section aria-labelledby="pos-grid-title" className="grid gap-3">
      <h2 id="pos-grid-title" className="sr-only">
        {text.tabsLabel}
      </h2>
      <nav aria-label={text.tabsLabel} className="flex flex-wrap gap-2">
        {POS_TABS.map((tab) => (
          <Link
            key={tab}
            href={props.tabHref(tab) as never}
            scroll={false}
            aria-current={tab === active ? "page" : undefined}
            className={`inline-flex min-h-11 items-center rounded-lg border px-3.5 text-[0.8125rem] font-semibold ${tab === active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-muted"}`}
          >
            {text.tab(tab)}
          </Link>
        ))}
      </nav>
      {active === "sessions" ? (
        props.sessions.length ? (
          <ul className="grid grid-cols-2 gap-2 lg:grid-cols-3">
            {props.sessions.map((s) => (
              <li key={s.sessionId}>
                {s.href ? (
                  <Link href={s.href as never} scroll={false} className={tile} aria-label={text.add(`${s.title} ${formatDateTime(s.startsAt, locale, "short")}`)}>
                    <span className="font-semibold">{s.title}</span>
                    <span className="text-muted-foreground">{formatDateTime(s.startsAt, locale, "short")}</span>
                    <span className="flex justify-between gap-2">
                      <span className="text-[var(--status-ok)]">{text.seatsFree(s.free)}</span>
                      <span className="font-semibold tabular-nums">{money(s.priceCents)}</span>
                    </span>
                  </Link>
                ) : (
                  <div className={`${tile} opacity-70`}>
                    <span className="font-medium">{s.title}</span>
                    <span>{formatDateTime(s.startsAt, locale, "short")}</span>
                    <span className="text-muted-foreground">{text.noPrice}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{text.noSessions}</p>
        )
      ) : props.products.length ? (
        <ul className={active === "food" ? "grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4" : "grid grid-cols-2 gap-2 lg:grid-cols-3"}>
          {props.products.map((p) => (
            <li key={p.id}>
              <Link href={p.href as never} scroll={false} className={`${tile} ${p.quantity ? "border-[#c9973a] bg-[#fbf6ec]" : ""}`} aria-label={p.quantity ? `${text.add(p.name)} (${text.inBasket(p.quantity)})` : text.add(p.name)}>
                <span className="pr-7 font-semibold">{p.name}</span>
                <span className="flex justify-between gap-2">
                  <span className="text-[0.75rem] text-muted-foreground">{p.tag ?? p.sku}</span>
                  <span className="font-semibold tabular-nums">{money(p.priceCents)}</span>
                </span>
                {p.quantity ? (
                  <span aria-hidden="true" className="absolute top-2 right-2 grid h-6 min-w-6 place-items-center rounded-full bg-[#8a5a14] px-1.5 text-[0.6875rem] font-semibold text-white tabular-nums">
                    {p.quantity}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{text.noProducts}</p>
      )}
    </section>
  );
}
